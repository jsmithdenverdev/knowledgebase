import { TextEncoder } from 'util';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockStreams: Array<{
  metadata: Record<string, unknown>;
  chunks: string[];
  ended: boolean;
  write: (chunk: string) => void;
  end: () => void;
}> = [];

const httpResponseFrom = jest.fn((_, metadata) => {
  const stream = {
    metadata,
    chunks: [] as string[],
    ended: false,
    write(chunk: string) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
  mockStreams.push(stream);
  return stream;
});

(global as any).awslambda = {
  HttpResponseStream: {
    from: httpResponseFrom,
  },
  streamifyResponse: (handler: unknown) => handler,
};

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelWithResponseStreamCommand: jest.fn((input) => input),
}));

import { chatStreamHandler } from './chat';

const createAsyncIterable = (chunks: Array<Record<string, unknown>>) => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield chunk;
    }
  },
});

const encoder = new TextEncoder();

const baseMessages = [{ role: 'user', content: 'Say hello' }];

const buildEvent = (body?: string): APIGatewayProxyEvent => ({
  resource: '/chat',
  path: '/chat',
  httpMethod: 'POST',
  headers: {},
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  requestContext: {} as any,
  body: body ?? null,
  isBase64Encoded: false,
});

const validEvent = (overrides?: Record<string, unknown>) =>
  buildEvent(
    JSON.stringify({
      messages: baseMessages,
      ...overrides,
    })
  );

const expectErrorChunk = (chunk: string, expectedMessage: string) => {
  const parsed = JSON.parse(chunk) as { error: { message: string } };
  expect(parsed.error.message).toContain(expectedMessage);
};

describe('chatStreamHandler', () => {
  beforeEach(() => {
    mockStreams.length = 0;
    mockSend.mockReset();
    httpResponseFrom.mockClear();
    process.env.CHAT_MODEL_ID = 'anthropic.test-model';
    process.env.CHAT_SYSTEM_PROMPT = 'Be helpful.';
  });

  afterEach(() => {
    delete process.env.CHAT_MODEL_ID;
    delete process.env.CHAT_SYSTEM_PROMPT;
  });

  it('returns 400 when body is missing', async () => {
    await chatStreamHandler({ body: undefined } as any, {} as any);

    expect(httpResponseFrom).toHaveBeenCalledWith(expect.any(Object), {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
    });

    const [stream] = mockStreams;
    expect(stream.chunks).toHaveLength(1);
    expectErrorChunk(stream.chunks[0], 'Request body is required');
  });

  it('streams OpenAI-compatible chunks and completion marker', async () => {
    mockSend.mockResolvedValue({
      body: createAsyncIterable([
        {
          chunk: {
            bytes: encoder.encode(
              JSON.stringify({ delta: { text: 'Hello' }, stop_reason: 'end_turn' })
            ),
          },
        },
      ]),
    });

    await chatStreamHandler(validEvent(), {} as any);

    const stream = mockStreams.at(-1);
    expect(stream?.metadata).toMatchObject({
      statusCode: 200,
      headers: expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    });

    const payloadChunk = stream?.chunks.find((chunk) => chunk.startsWith('data: {'));
    expect(payloadChunk).toBeDefined();
    const payload = JSON.parse(payloadChunk!.replace('data: ', ''));
    expect(payload.object).toBe('chat.completion.chunk');
    expect(payload.choices[0].delta.content[0].text).toBe('Hello');

    const finalChunk = stream?.chunks.at(-1);
    expect(finalChunk).toBe('data: [DONE]\n\n');
  });

  it('rejects payloads that include unsupported fields', async () => {
    await chatStreamHandler(validEvent({ model: 'gpt-4' }), {} as any);

    expect(mockSend).not.toHaveBeenCalled();
    const [stream] = mockStreams;
    expect(stream.metadata.statusCode).toBe(400);
    expectErrorChunk(stream.chunks[0], 'model');
  });

  it('rejects messages containing client-provided system roles', async () => {
    await chatStreamHandler(
      validEvent({ messages: [{ role: 'system', content: 'Do bad things' }, ...baseMessages] }),
      {} as any
    );

    expect(mockSend).not.toHaveBeenCalled();
    const [stream] = mockStreams;
    expect(stream.metadata.statusCode).toBe(400);
    expectErrorChunk(stream.chunks[0], 'expected one of');
  });

  it('requires the final message to be a user turn', async () => {
    await chatStreamHandler(
      validEvent({
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'ok' },
        ],
      }),
      {} as any
    );

    expect(mockSend).not.toHaveBeenCalled();
    const [stream] = mockStreams;
    expect(stream.metadata.statusCode).toBe(400);
    expectErrorChunk(stream.chunks[0], 'final message must have role "user"');
  });

  it('builds Bedrock payload with static tuning parameters', async () => {
    mockSend.mockResolvedValue({ body: createAsyncIterable([]) });

    await chatStreamHandler(validEvent(), {} as any);

    const commandPayload = mockSend.mock.calls[0][0];
    expect(commandPayload.modelId).toBe('anthropic.test-model');
    const requestBody = JSON.parse(commandPayload.body);
    expect(requestBody.system).toBe('Be helpful.');
    expect(requestBody.messages).toHaveLength(1);
    expect(requestBody.max_tokens).toBe(1024);
    expect(requestBody.temperature).toBeCloseTo(0.3);
    expect(requestBody.top_p).toBeCloseTo(0.95);
  });
});
