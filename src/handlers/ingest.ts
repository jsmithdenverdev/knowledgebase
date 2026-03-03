import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import { Handler, S3Event } from 'aws-lambda';
import {
  BedrockAgentClient,
  ListDataSourcesCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import { v4 as uuidv4 } from 'uuid';

const log = new Logger({ serviceName: 'ingest-handler' });
const bedrockAgentClient = new BedrockAgentClient({});
let cachedDataSourceId: string | undefined;

const resolveDataSourceId = async (
  knowledgeBaseId: string,
  explicitlyConfiguredId?: string,
  dataSourceName?: string
): Promise<string> => {
  if (explicitlyConfiguredId) {
    return explicitlyConfiguredId;
  }

  if (cachedDataSourceId) {
    return cachedDataSourceId;
  }

  if (!dataSourceName) {
    throw new Error('DATA_SOURCE_NAME must be configured when DATA_SOURCE_ID is not provided');
  }

  const listResponse = await bedrockAgentClient.send(
    new ListDataSourcesCommand({ knowledgeBaseId, maxResults: 50 })
  );

  const match = listResponse.dataSourceSummaries?.find(
    (summary) => summary.name === dataSourceName
  );

  if (!match?.dataSourceId) {
    throw new Error(`Data source named "${dataSourceName}" not found in knowledge base`);
  }

  cachedDataSourceId = match.dataSourceId;
  return cachedDataSourceId;
};

const ingestHandler: Handler<S3Event> = async (event) => {
  log.info('S3 event received', { records: event.Records.length });

  const documentKeys = event.Records.filter((record) =>
    record.eventName.startsWith('ObjectCreated')
  ).map((record) => ({
    key: decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')),
    bucket: record.s3.bucket.name,
  }));

  if (documentKeys.length === 0) {
    log.info('No new documents to ingest');
    return {
      statusCode: 202,
      body: JSON.stringify({ message: 'No new documents to ingest' }),
    };
  }

  const { KNOWLEDGE_BASE_ID, DATA_SOURCE_ID, DATA_SOURCE_NAME } = process.env;
  if (!KNOWLEDGE_BASE_ID) {
    log.error('Missing knowledge base configuration');
    throw new Error('Knowledge base configuration is missing');
  }

  const dataSourceId = await resolveDataSourceId(
    KNOWLEDGE_BASE_ID,
    DATA_SOURCE_ID,
    DATA_SOURCE_NAME
  );

  try {
    const command = new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId,
      clientToken: uuidv4(),
    });

    const response = await bedrockAgentClient.send(command);
    const ingestionJobId = response.ingestionJob?.ingestionJobId;

    log.info('Started ingestion job', {
      ingestionJobId,
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId,
      documentCount: documentKeys.length,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Ingestion job started',
        ingestionJobId,
        documentCount: documentKeys.length,
      }),
    };
  } catch (error) {
    log.error('Failed to start ingestion job', {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    throw error;
  }
};

export const handler = middy(ingestHandler).use(errorHandler());
