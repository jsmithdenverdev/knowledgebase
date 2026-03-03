import { handler as defaultHandler } from './default';

describe('defaultHandler', () => {
  it('should process incoming WebSocket messages on $default route', async () => {
    const mockEvent: any = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: '$default',
        apiId: 'test-api-id',
      },
      body: JSON.stringify({ action: 'sendMessage', content: 'Hello' }),
    };

    const mockContext: any = {
      functionName: 'defaultHandler',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:defaultHandler',
      memoryLimitInMB: 512,
    };

    const result = await defaultHandler(mockEvent, mockContext);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Message processed');
  });

  it('should handle messages without body', async () => {
    const mockEvent: any = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: '$default',
        apiId: 'test-api-id',
      },
      body: null,
    };

    const mockContext: any = {
      functionName: 'defaultHandler',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:defaultHandler',
      memoryLimitInMB: 512,
    };

    const result = await defaultHandler(mockEvent, mockContext);

    expect(result.statusCode).toBe(200);
  });
});
