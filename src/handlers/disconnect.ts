import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import { Handler, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

const log = new Logger({ serviceName: 'disconnect-handler' });

const disconnectHandler: Handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const { connectionId } = event.requestContext;

  log.info('WebSocket disconnected', { connectionId });

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Disconnected', connectionId }),
  };
};

export const handler = middy(disconnectHandler).use(errorHandler());
