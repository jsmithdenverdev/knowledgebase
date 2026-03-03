import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import { Handler, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

const log = new Logger({ serviceName: 'default-handler' });

const defaultHandler: Handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const { connectionId, routeKey } = event.requestContext;

  log.info('WebSocket default route message received', { connectionId, routeKey });

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (error) {
      log.warn('Non-JSON message received', { body: event.body });
      body = { rawMessage: event.body };
    }
  }

  log.debug('Message body', { body });

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Message processed' }),
  };
};

export const handler = middy(defaultHandler).use(httpJsonBodyParser()).use(errorHandler());
