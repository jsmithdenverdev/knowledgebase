import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import { Handler, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

const log = new Logger({ serviceName: 'connect-handler' });

const connectHandler: Handler = async (event: APIGatewayProxyWebsocketEventV2) => {
  const { connectionId } = event.requestContext;

  log.info('New WebSocket connection', { connectionId });

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Connected', connectionId }),
  };
};

export const handler = middy(connectHandler).use(errorHandler());
