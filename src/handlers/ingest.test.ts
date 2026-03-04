jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agent', () => {
  return {
    BedrockAgentClient: jest.fn(() => ({ send: mockSend })),
    ListDataSourcesCommand: jest.fn((input) => input),
    StartIngestionJobCommand: jest.fn((input) => input),
  };
});

import { handler as ingestHandler } from './ingest';

describe('ingestHandler', () => {
  const mockContext: any = {};

  beforeEach(() => {
    process.env.KNOWLEDGE_BASE_ID = 'kb-test';
    process.env.DATA_SOURCE_ID = 'ds-test';
    mockSend.mockResolvedValue({ ingestionJob: { ingestionJobId: 'job-123' } });
  });

  afterEach(() => {
    delete process.env.KNOWLEDGE_BASE_ID;
    delete process.env.DATA_SOURCE_ID;
    mockSend.mockReset();
  });

  it('returns 202 when no new documents exist', async () => {
    const result = await ingestHandler({ Records: [] } as any, mockContext, () => undefined);

    expect(result.statusCode).toBe(202);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('starts an ingestion job when new documents arrive', async () => {
    const s3Event: any = {
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: {
            bucket: { name: 'bucket' },
            object: { key: 'documents/sample.pdf' },
          },
        },
      ],
    };

    const result = await ingestHandler(s3Event, mockContext, () => undefined);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      statusCode: 200,
    });
    const body = JSON.parse(result.body);
    expect(body.ingestionJobId).toBe('job-123');
    expect(body.documentCount).toBe(1);
  });
});
