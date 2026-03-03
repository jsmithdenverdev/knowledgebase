import { handler as connectHandler } from './connect';

describe('connectHandler', () => {
  it('should return a success response with connectionId', async () => {
    const mockEvent: any = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: '$connect',
        apiId: 'test-api-id',
      },
      body: null,
    };

    const mockContext: any = {
      functionName: 'connectHandler',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:connectHandler',
      memoryLimitInMB: 512,
    };

    const result = await connectHandler(mockEvent, mockContext);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.connectionId).toBe('test-connection-id');
  });
});
