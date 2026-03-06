import { randomUUID } from 'crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ZodError } from 'zod';

import { normalizeMessages, openAiErrorPayload, parseChatRequest } from '../models/openai-chat';
import type { NormalizedChatMessage } from '../models/openai-chat';

const log = new Logger({ serviceName: 'chat-handler' });
const bedrockRuntime = new BedrockRuntimeClient({});
const textDecoder = new TextDecoder();

const DEFAULT_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TOP_P = 0.95;

let systemPromptWarningEmitted = false;
const getSystemPrompt = (): string | undefined => {
  const prompt = process.env.CHAT_SYSTEM_PROMPT?.trim();
  if (!prompt && !systemPromptWarningEmitted) {
    log.warn('CHAT_SYSTEM_PROMPT not set; proceeding without system instructions.');
    systemPromptWarningEmitted = true;
  }
  return prompt;
};

type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string }>;
};

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls';

const createMetadataResponse = (
  responseStream: awslambda.HttpResponseStream,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
) =>
  function respond(statusCode: number, body: Record<string, unknown>) {
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers,
    });
    httpStream.write(JSON.stringify(body));
    httpStream.end();
  };

const extractTextDelta = (payload: Record<string, unknown>): string | null => {
  const textValue = payload.text;
  if (typeof textValue === 'string') {
    return textValue;
  }

  const deltaCandidate = payload.delta;
  if (typeof deltaCandidate === 'object' && deltaCandidate !== null) {
    const delta = deltaCandidate as Record<string, unknown>;
    const deltaText = delta.text;
    if (typeof deltaText === 'string') {
      return deltaText;
    }

    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
  }

  const completionValue = payload.completion;
  if (typeof completionValue === 'string') {
    return completionValue;
  }

  const outputText = payload.output_text;
  if (Array.isArray(outputText)) {
    return outputText.filter((part) => typeof part === 'string').join('');
  }

  const messageCandidate = payload.message;
  if (
    messageCandidate &&
    typeof messageCandidate === 'object' &&
    'content' in messageCandidate &&
    Array.isArray((messageCandidate as { content?: unknown[] }).content)
  ) {
    const combined = (messageCandidate as { content: Array<{ text?: unknown }> }).content
      .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
      .join('');
    return combined || null;
  }

  return null;
};

const extractStopReason = (payload: Record<string, unknown>): string | null => {
  const deltaCandidate = payload.delta;
  if (
    deltaCandidate &&
    typeof deltaCandidate === 'object' &&
    typeof (deltaCandidate as Record<string, unknown>).stop_reason === 'string'
  ) {
    return (deltaCandidate as Record<string, unknown>).stop_reason as string;
  }
  const stopReason = payload.stop_reason;
  if (typeof stopReason === 'string') {
    return stopReason;
  }
  const completionReason = payload.completion_reason;
  if (typeof completionReason === 'string') {
    return completionReason;
  }
  return null;
};

const mapFinishReason = (reason: string | null): FinishReason | null => {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'user':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_use':
      return 'tool_calls';
    default:
      return null;
  }
};

const sendStreamError = (httpStream: awslambda.HttpResponseStream, message: string) => {
  httpStream.write('event: error\n');
  httpStream.write(`data: ${JSON.stringify(openAiErrorPayload(message, 'server_error'))}\n\n`);
  httpStream.end();
};

const streamBedrockResponse = async (
  body: AsyncIterable<any>,
  httpStream: awslambda.HttpResponseStream,
  modelId: string
) => {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const systemFingerprint = `bedrock:${modelId}`;
  let assistantRoleSent = false;
  let finishChunkSent = false;

  const writeChunk = (contentText?: string, finishReason?: FinishReason | null) => {
    if (!contentText && finishReason === undefined) {
      return;
    }

    const delta: Record<string, unknown> = {};
    if (contentText) {
      if (!assistantRoleSent) {
        delta.role = 'assistant';
        assistantRoleSent = true;
      }
      delta.content = [{ type: 'text', text: contentText }];
    }

    const payload = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      system_fingerprint: systemFingerprint,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason ?? null,
        },
      ],
    };

    httpStream.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  for await (const eventPayload of body) {
    if (eventPayload.chunk?.bytes) {
      const decoded = textDecoder.decode(eventPayload.chunk.bytes);
      try {
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        const text = extractTextDelta(parsed);
        if (text) {
          writeChunk(text);
        }

        const stopReason = extractStopReason(parsed);
        const finishReason = mapFinishReason(stopReason);
        if (finishReason && !finishChunkSent) {
          writeChunk(undefined, finishReason);
          finishChunkSent = true;
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

  if (!finishChunkSent) {
    writeChunk(undefined, 'stop');
  }

  httpStream.write('data: [DONE]\n\n');
  httpStream.end();
};

export const chatStreamHandler = async (
  event: APIGatewayProxyEvent,
  responseStream: awslambda.HttpResponseStream
) => {
  const metadataResponse = createMetadataResponse(responseStream);

  if (!event.body) {
    metadataResponse(400, openAiErrorPayload('Request body is required.', 'invalid_request_error'));
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(event.body);
  } catch {
    metadataResponse(
      400,
      openAiErrorPayload('Request body must be valid JSON.', 'invalid_request_error')
    );
    return;
  }

  let chatRequest;
  try {
    chatRequest = parseChatRequest(parsedBody);
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues.at(0);
      metadataResponse(
        400,
        openAiErrorPayload(firstIssue?.message ?? 'Invalid chat request.', 'invalid_request_error')
      );
      return;
    }
    metadataResponse(400, openAiErrorPayload('Invalid chat request.', 'invalid_request_error'));
    return;
  }

  let normalizedMessages;
  try {
    normalizedMessages = normalizeMessages(chatRequest.messages);
  } catch (error) {
    metadataResponse(
      400,
      openAiErrorPayload(
        error instanceof Error ? error.message : 'Invalid messages payload.',
        'invalid_request_error'
      )
    );
    return;
  }

  type ConversationMessage = NormalizedChatMessage & { role: 'user' | 'assistant' };
  const conversation = normalizedMessages.filter(
    (message): message is ConversationMessage =>
      message.role === 'user' || message.role === 'assistant'
  );
  if (!conversation.length) {
    metadataResponse(
      400,
      openAiErrorPayload(
        'messages must include at least one user message.',
        'invalid_request_error'
      )
    );
    return;
  }

  const latestMessage = conversation.at(-1);
  if (latestMessage?.role !== 'user') {
    metadataResponse(
      400,
      openAiErrorPayload('The final message must have role "user".', 'invalid_request_error')
    );
    return;
  }

  const messagesForClaude: ClaudeMessage[] = conversation.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));

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
    const systemPrompt = getSystemPrompt();
    const command = new InvokeModelWithResponseStreamCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        messages: messagesForClaude,
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        top_p: DEFAULT_TOP_P,
        ...(systemPrompt ? { system: systemPrompt } : {}),
      }),
    });

    const bedrockResponse = await bedrockRuntime.send(command);
    if (!bedrockResponse.body) {
      sendStreamError(httpStream, 'No response body received from Bedrock.');
      return;
    }

    await streamBedrockResponse(bedrockResponse.body, httpStream, modelId);
  } catch (error) {
    log.error('Chat handler failed', {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    sendStreamError(httpStream, 'Failed to generate response.');
  }
};

export const handler = awslambda.streamifyResponse(chatStreamHandler);
