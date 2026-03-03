import { handler as defaultHandler } from './default';

describe('defaultHandler', () => {
  it('should require query in message body', async () => {
    const mockEvent: any = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: '$default',
        apiId: 'test-api-id',
        stage: 'prod',
      },
      body: JSON.stringify({}),
    };

    const mockContext: any = {
      functionName: 'defaultHandler',
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:defaultHandler',
      memoryLimitInMB: 512,
    };

    const originalEnv = process.env;
    process.env.KNOWLEDGE_BASE_ID = 'test-kb-id';
    process.env.AWS_REGION = 'us-east-1';

    try {
      await defaultHandler(mockEvent, mockContext);
      fail('Should have thrown error');
    } catch (error) {
      expect((error as Error).message).toBe('Query is required');
    } finally {
      process.env = originalEnv;
    }
  });
});
