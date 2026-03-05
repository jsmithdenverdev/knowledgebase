import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { APIGatewayProxyEvent } from 'aws-lambda';
import 'aws-lambda';

const log = new Logger({ serviceName: 'chat-handler' });
const bedrockRuntime = new BedrockRuntimeClient({});
const textDecoder = new TextDecoder();

type ChatRequestBody = {
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
};

const DEFAULT_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

export const chatStreamHandler = async (
  event: APIGatewayProxyEvent,
  responseStream: awslambda.HttpResponseStream
) => {
  const metadataResponse = (statusCode: number, body: Record<string, unknown>) => {
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
    httpStream.write(JSON.stringify(body));
    httpStream.end();
  };

  if (!event.body) {
    metadataResponse(400, { message: 'Request body is required.' });
    return;
  }

  let payload: ChatRequestBody;
  try {
    payload = JSON.parse(event.body);
  } catch {
    metadataResponse(400, { message: 'Request body must be valid JSON.' });
    return;
  }

  const prompt = payload.prompt?.trim();
  if (!prompt) {
    metadataResponse(400, { message: 'The "prompt" field is required.' });
    return;
  }

  const modelId = process.env.CHAT_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  if (!process.env.CHAT_MODEL_ID) {
    log.debug('CHAT_MODEL_ID not set; using default model', { modelId });
  }

  const httpStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });

  try {
    const command = new InvokeModelWithResponseStreamCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
        max_tokens: payload.maxTokens ?? 1024,
        temperature: payload.temperature ?? 0.3,
      }),
    });

    const bedrockResponse = await bedrockRuntime.send(command);
    if (!bedrockResponse.body) {
      httpStream.write('event: message\ndata: No response body received\n\n');
      httpStream.end();
      return;
    }

    for await (const eventPayload of bedrockResponse.body) {
      if (eventPayload.chunk?.bytes) {
        const decoded = textDecoder.decode(eventPayload.chunk.bytes);
        try {
          const parsed = JSON.parse(decoded);
          const delta = parsed.delta?.text ?? parsed.completion ?? parsed.output_text;
          if (delta) {
            httpStream.write(`data: ${delta}\n\n`);
          }
        } catch (error) {
          log.warn('Failed to parse Bedrock chunk', {
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }

      if (eventPayload.internalServerException) {
        throw new Error(eventPayload.internalServerException.message || 'Internal Bedrock error');
      }
      if (eventPayload.throttlingException) {
        throw new Error(eventPayload.throttlingException.message || 'Bedrock throttling error');
      }
      if (eventPayload.validationException) {
        throw new Error(eventPayload.validationException.message || 'Bedrock validation error');
      }
    }

    httpStream.write('data: [DONE]\n\n');
    httpStream.end();
  } catch (error) {
    log.error('Chat handler failed', {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    httpStream.write('event: error\n');
    httpStream.write(`data: ${JSON.stringify({ message: 'Failed to generate response.' })}\n\n`);
    httpStream.end();
  }
};

export const handler = awslambda.streamifyResponse(chatStreamHandler);
