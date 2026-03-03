import middy from '@middy/core';
import { Logger } from '@aws-lambda-powertools/logger';
import errorHandler from '@middy/http-error-handler';
import { Handler, S3Event } from 'aws-lambda';

const log = new Logger({ serviceName: 'ingest-handler' });

const ingestHandler: Handler = async (event: S3Event) => {
  log.info('S3 event received', { Records: event.Records });

  const documentIds: string[] = [];

  for (const record of event.Records) {
    if (record.eventName === 'ObjectCreated') {
      const key = record.s3.object.key;
      const bucket = record.s3.bucket.name;

      log.info('New document uploaded', { key, bucket });

      documentIds.push(`s3://${bucket}/${key}`);
    }
  }

  if (documentIds.length > 0) {
    log.info('Documents ready for ingestion', {
      documentCount: documentIds.length,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Documents received',
      count: documentIds.length,
    }),
  };
};

export const handler = middy(ingestHandler).use(errorHandler());
