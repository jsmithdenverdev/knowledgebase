import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3_notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

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

    const connectionTable = new dynamodb.Table(this, 'ConnectionTable', {
      tableName: 'connections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const parametersTable = new dynamodb.Table(this, 'ParametersTable', {
      tableName: 'system-parameters',
      partitionKey: { name: 'parameterKey', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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
          'bedrock:IngestKnowledgeBaseDocuments',
        ],
        resources: ['*'],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: ['*'],
      })
    );

    connectionTable.grantReadWriteData(lambdaRole);
    parametersTable.grantReadWriteData(lambdaRole);
    knowledgeBaseBucket.grantRead(lambdaRole);
    knowledgeBaseBucket.grantWrite(lambdaRole);

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: 'KnowledgeBase',
      roleArn: lambdaRole.roleArn,
      description: 'Knowledge base for RAG application',
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          vectorDatabaseConfiguration: {
            type: 'OPENSEARCH_SERVERLESS',
            opensearchServerlessConfiguration: {
              fieldMappings: {
                vectorField: 'vector_field',
                textField: 'text_field',
                metadataField: 'metadata_field',
              },
            },
          },
        },
      },
    });

    const commonLambdaProps = {
      role: lambdaRole,
      environment: {
        CONNECTIONS_TABLE: connectionTable.tableName,
        PARAMETERS_TABLE: parametersTable.tableName,
        KNOWLEDGE_BASE_BUCKET: knowledgeBaseBucket.bucketName,
        KNOWLEDGE_BASE_ID: knowledgeBase.ref,
      },
    };

    const connectLambda = new NodejsFunction(this, 'ConnectLambda', {
      ...commonLambdaProps,
      entry: 'src/handlers/connect.ts',
    });

    const ingestLambda = new NodejsFunction(this, 'IngestLambda', {
      ...commonLambdaProps,
      entry: 'src/handlers/ingest.ts',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    const defaultLambda = new NodejsFunction(this, 'DefaultLambda', {
      ...commonLambdaProps,
      entry: 'src/handlers/default.ts',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    const disconnectLambda = new NodejsFunction(this, 'DisconnectLambda', {
      ...commonLambdaProps,
      entry: 'src/handlers/disconnect.ts',
    });

    knowledgeBaseBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3_notifications.LambdaDestination(ingestLambda),
      { filters: [{ prefix: 'documents/' }] }
    );

    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: 'KnowledgeBaseWebSocket',
      routeSelectionExpression: '$request.body.action',
    });

    const connectIntegration = new apigatewayv2_integrations.WebSocketLambdaIntegration(
      'ConnectIntegration',
      connectLambda
    );

    const disconnectIntegration = new apigatewayv2_integrations.WebSocketLambdaIntegration(
      'DisconnectIntegration',
      disconnectLambda
    );

    const defaultIntegration = new apigatewayv2_integrations.WebSocketLambdaIntegration(
      'DefaultIntegration',
      defaultLambda
    );

    webSocketApi.addRoute('$connect', { integration: connectIntegration });
    webSocketApi.addRoute('$disconnect', { integration: disconnectIntegration });
    webSocketApi.addRoute('$default', { integration: defaultIntegration });

    const stage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      stageName: 'prod',
      webSocketApi,
      autoDeploy: true,
    });

    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: stage.url,
      description: 'WebSocket API endpoint URL',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseBucketName', {
      value: knowledgeBaseBucket.bucketName,
      description: 'S3 bucket for knowledge base documents',
    });
  }
}
