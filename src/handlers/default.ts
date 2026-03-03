import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import { Handler, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const log = new Logger({ serviceName: 'default-handler' });

const defaultHandler: Handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const { connectionId, routeKey } = event.requestContext;
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;

  if (!knowledgeBaseId) {
    throw new Error('KNOWLEDGE_BASE_ID environment variable is not set');
  }

  log.info('WebSocket default route message received', { connectionId, routeKey });

  let body: any = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (error) {
      log.warn('Non-JSON message received', { body: event.body });
      body = { rawMessage: event.body };
    }
  }

  log.debug('Message body', { body });

  const { query } = body;

  if (!query) {
    throw new Error('Query is required');
  }

  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

  try {
    log.info('Calling Bedrock InvokeModel', { query });

    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: query,
          },
        ],
      }),
    });

    const response = await client.send(command);

    let completion = '';
    if (response.body) {
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        if (typeof chunk === 'string') {
          completion += chunk;
        } else {
          completion += decoder.decode(chunk as unknown as Uint8Array);
        }
      }
    }

    log.info('Bedrock response received', {
      completionLength: completion.length,
    });

    const apiGatewayClient = new ApiGatewayManagementApiClient({
      endpoint: `https://${event.requestContext.apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/${event.requestContext.stage}`,
    });

    const postCommand = new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({
        response: completion,
      }),
    });

    await apiGatewayClient.send(postCommand);

    log.info('Response sent to client', { connectionId });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Query processed',
        query,
      }),
    };
  } catch (error) {
    log.error('Failed to process query', { error });
    throw error;
  }
};

export const handler = middy(defaultHandler).use(httpJsonBodyParser()).use(errorHandler());
