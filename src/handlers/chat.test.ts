import { TextEncoder } from 'util';

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

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
    InvokeModelWithResponseStreamCommand: jest.fn((input) => input),
  };
});

import { chatStreamHandler } from './chat';

const createAsyncIterable = (chunks: Array<Record<string, unknown>>) => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield chunk;
    }
  },
});

describe('chatStreamHandler', () => {
  beforeEach(() => {
    mockStreams.length = 0;
    mockSend.mockReset();
    httpResponseFrom.mockClear();
  });

  it('returns 400 when body is missing', async () => {
    await chatStreamHandler({ body: undefined } as any, {} as any);

    expect(httpResponseFrom).toHaveBeenCalledWith(expect.any(Object), {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(mockStreams[0].chunks[0]).toContain('Request body is required');
  });

  it('streams bedrock chunks and completion marker', async () => {
    const encoder = new TextEncoder();
    mockSend.mockResolvedValue({
      body: createAsyncIterable([
        {
          chunk: {
            bytes: encoder.encode(JSON.stringify({ delta: { text: 'Hello' } })),
          },
        },
      ]),
    });

    await chatStreamHandler({ body: JSON.stringify({ prompt: 'Hi' }) } as any, {} as any);

    const stream = mockStreams.at(-1);
    expect(stream?.metadata).toMatchObject({ statusCode: 200 });
    expect(stream?.chunks).toEqual(expect.arrayContaining(['data: Hello\n\n', 'data: [DONE]\n\n']));
  });

  it('emits error event when bedrock call fails', async () => {
    mockSend.mockRejectedValue(new Error('boom'));

    await chatStreamHandler({ body: JSON.stringify({ prompt: 'Fail' }) } as any, {} as any);

    const stream = mockStreams.at(-1);
    expect(stream?.chunks.at(-1)).toContain('Failed to generate response');
  });
});
