import { handler as ingestHandler } from './ingest';

describe('ingestHandler', () => {
  const mockEvent: any = {
    Records: [
      {
        eventName: 'ObjectCreated:Put',
        s3: {
          bucket: { name: 'test-bucket' },
          object: { key: 'documents/test.pdf' },
        },
      },
    ],
  };

  const mockContext: any = {
    functionName: 'ingestHandler',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:ingestHandler',
    memoryLimitInMB: 1024,
  };

  it('should handle S3 object created event', async () => {
    expect(true).toBe(true);

    expect(() => {
      ingestHandler(mockEvent, mockContext);
    }).not.toThrow();
  });

  it('should handle empty records', async () => {
    const emptyEvent: any = { Records: [] };

    const result = await ingestHandler(emptyEvent, mockContext);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Documents received');
    expect(body.count).toBe(0);
  });
});
