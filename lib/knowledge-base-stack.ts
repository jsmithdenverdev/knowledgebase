import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3_notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3Vectors from 'cdk-s3-vectors';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  env?: cdk.Environment;
}

export class KnowledgeBaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    const knowledgeBaseBucket = new s3.Bucket(this, 'KnowledgeBaseBucket', {
      bucketName: `knowledge-base-docs-${this.account}-${this.region}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
          'bedrock:StartIngestionJob',
          'bedrock:GetIngestionJob',
          'bedrock:ListDataSources',
        ],
        resources: ['*'],
      })
    );

    knowledgeBaseBucket.grantRead(lambdaRole);
    knowledgeBaseBucket.grantWrite(lambdaRole);

    const vectorBucketName = cdk.Fn.join('-', [
      'knowledge-base-vectors',
      cdk.Aws.ACCOUNT_ID,
      cdk.Aws.REGION,
    ]);

    const vectorBucket = new s3Vectors.Bucket(this, 'VectorBucket', {
      vectorBucketName,
    });

    const vectorIndex = new s3Vectors.Index(this, 'VectorIndex', {
      vectorBucketName: vectorBucket.vectorBucketName,
      indexName: 'documents-index',
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
          'x-amz-bedrock-kb-parent-text',
          'x-amz-bedrock-kb-metadata-json',
        ],
      },
    });
    vectorIndex.node.addDependency(vectorBucket);

    const knowledgeBase = new s3Vectors.KnowledgeBase(this, 'KnowledgeBase', {
      knowledgeBaseName: cdk.Fn.join('-', ['knowledge-base', cdk.Aws.ACCOUNT_ID, cdk.Aws.REGION]),
      vectorBucketArn: vectorBucket.vectorBucketArn,
      indexArn: vectorIndex.indexArn,
      description: 'Knowledge base for RAG application',
      knowledgeBaseConfiguration: {
        embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        embeddingDataType: 'FLOAT32',
        dimensions: '1024',
      },
    });
    knowledgeBase.node.addDependency(vectorIndex);
    knowledgeBase.node.addDependency(vectorBucket);

    knowledgeBaseBucket.grantRead(knowledgeBase.role);
    knowledgeBase.grantIngestion(lambdaRole);

    const dataSourceName = 'documents-data-source';

    const dataSource = new bedrock.CfnDataSource(this, 'DocumentsDataSource', {
      name: dataSourceName,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: knowledgeBaseBucket.bucketArn,
        },
      },
    });

    const ingestLambda = new NodejsFunction(this, 'IngestLambda', {
      role: lambdaRole,
      entry: 'src/handlers/ingest.ts',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DATA_SOURCE_NAME: dataSourceName,
      },
    });

    const chatLambda = new NodejsFunction(this, 'ChatLambda', {
      role: lambdaRole,
      entry: 'src/handlers/chat.ts',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
      },
    });

    knowledgeBaseBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3_notifications.LambdaDestination(ingestLambda),
      { prefix: 'documents/' }
    );

    const chatApi = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: 'KnowledgeBaseChatApi',
      deployOptions: {
        stageName: 'prod',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });

    const chatIntegration = new apigateway.LambdaIntegration(chatLambda, {
      proxy: true,
      allowTestInvoke: false,
      responseTransferMode: apigateway.ResponseTransferMode.STREAM,
    });

    chatApi.root.addResource('chat').addMethod('POST', chatIntegration);

    new cdk.CfnOutput(this, 'ChatApiUrl', {
      value: `${chatApi.url}chat`,
      description: 'REST API endpoint for chat streaming',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', {
      value: knowledgeBaseBucket.bucketName,
      description: 'S3 bucket for knowledge base documents',
    });
  }
}
