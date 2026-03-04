import { BundlingOptions, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

export const sharedNodeBundling: BundlingOptions = {
  minify: true,
  sourceMap: false,
  sourcesContent: false,
  format: OutputFormat.CJS,
  target: 'node24',
  externalModules: ['@aws-sdk/*', 'aws-lambda'],
};
