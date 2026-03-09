import { randomUUID } from 'crypto';
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ZodError } from 'zod';

import { normalizeMessages, openAiErrorPayload, parseChatRequest } from '../models/openai-chat';
import type { NormalizedChatMessage } from '../models/openai-chat';

const log = new Logger({ serviceName: 'chat-handler' });
const bedrockAgentRuntime = new BedrockAgentRuntimeClient({});
const textDecoder = new TextDecoder();

type ConversationMessage = NormalizedChatMessage & { role: 'user' | 'assistant' };
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

const sendStreamError = (httpStream: awslambda.HttpResponseStream, message: string) => {
  httpStream.write('event: error\n');
  httpStream.write(`data: ${JSON.stringify(openAiErrorPayload(message, 'server_error'))}\n\n`);
  httpStream.end();
};

const getAgentConfiguration = () => {
  const agentId = process.env.AGENT_ID?.trim();
  const agentAliasId = (process.env.AGENT_ALIAS_ID ?? 'TSTALIASID').trim();
  if (!agentId || !agentAliasId) {
    return null;
  }
  return { agentId, agentAliasId };
};

const buildAgentInputText = (conversation: ConversationMessage[]): string => {
  const latestMessage = conversation.at(-1);
  if (!latestMessage) {
    return '';
  }

  if (conversation.length === 1) {
    return latestMessage.content;
  }

  const history = conversation
    .slice(0, -1)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n');

  return `${history}\nUser: ${latestMessage.content}`;
};

const streamAgentResponse = async (
  completion: AsyncIterable<any>,
  httpStream: awslambda.HttpResponseStream,
  agentId: string
) => {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const systemFingerprint = `bedrock-agent:${agentId}`;
  let assistantRoleSent = false;

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
      model: agentId,
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

  const handleErrorEvent = (event: Record<string, { message?: string }>, fallback: string) => {
    const entry = Object.values(event)[0];
    throw new Error(entry?.message ?? fallback);
  };

  for await (const event of completion) {
    if (event.chunk?.bytes) {
      const text = textDecoder.decode(event.chunk.bytes);
      if (text) {
        writeChunk(text);
      }
      continue;
    }

    if (event.trace || event.returnControl || event.files) {
      log.debug('Received agent trace event', {
        hasTrace: Boolean(event.trace),
        hasReturnControl: Boolean(event.returnControl),
        hasFiles: Boolean(event.files),
      });
      continue;
    }

    if (event.internalServerException) {
      handleErrorEvent(event, 'Agent internal error');
    }
    if (event.validationException) {
      handleErrorEvent(event, 'Agent validation error');
    }
    if (event.resourceNotFoundException) {
      handleErrorEvent(event, 'Agent or alias not found');
    }
    if (event.serviceQuotaExceededException) {
      handleErrorEvent(event, 'Agent quota exceeded');
    }
    if (event.throttlingException) {
      handleErrorEvent(event, 'Agent throttled your request');
    }
    if (event.accessDeniedException) {
      handleErrorEvent(event, 'Access denied while invoking agent');
    }
    if (event.conflictException) {
      handleErrorEvent(event, 'Agent conflict error');
    }
    if (event.dependencyFailedException) {
      handleErrorEvent(event, 'Agent dependency failure');
    }
    if (event.badGatewayException) {
      handleErrorEvent(event, 'Agent gateway failure');
    }
    if (event.modelNotReadyException) {
      handleErrorEvent(event, 'Agent model not ready');
    }
  }

  writeChunk(undefined, 'stop');
  httpStream.write('data: [DONE]\n\n');
  httpStream.end();
};

export const chatStreamHandler = async (
  event: APIGatewayProxyEvent,
  responseStream: awslambda.HttpResponseStream
) => {
  const metadataResponse = createMetadataResponse(responseStream);

  const agentConfiguration = getAgentConfiguration();
  if (!agentConfiguration) {
    metadataResponse(500, openAiErrorPayload('Agent configuration missing.', 'server_error'));
    return;
  }

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

  const inputText = buildAgentInputText(conversation);
  if (!inputText) {
    metadataResponse(
      400,
      openAiErrorPayload('messages must contain non-empty content.', 'invalid_request_error')
    );
    return;
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
    const sessionId = randomUUID();
    const command = new InvokeAgentCommand({
      agentId: agentConfiguration.agentId,
      agentAliasId: agentConfiguration.agentAliasId,
      sessionId,
      inputText,
    });

    const agentResponse = await bedrockAgentRuntime.send(command);
    if (!agentResponse.completion) {
      sendStreamError(httpStream, 'No completion stream returned by Bedrock agent.');
      return;
    }

    await streamAgentResponse(agentResponse.completion, httpStream, agentConfiguration.agentId);
  } catch (error) {
    log.error('Chat handler failed', {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    sendStreamError(httpStream, 'Failed to generate response.');
  }
};

export const handler = awslambda.streamifyResponse(chatStreamHandler);
