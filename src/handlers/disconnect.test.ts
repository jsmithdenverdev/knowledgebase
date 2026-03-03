import { handler as disconnectHandler } from './disconnect';

describe('disconnectHandler', () => {
  it('should return a success response when disconnecting', async () => {
    const mockEvent: any = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: '$disconnect',
        apiId: 'test-api-id',
      },
      body: null,
    };

    const mockContext: any = {
      functionName: 'disconnectHandler',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:disconnectHandler',
      memoryLimitInMB: 512,
    };

    const result = await disconnectHandler(mockEvent, mockContext);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.connectionId).toBe('test-connection-id');
  });
});
