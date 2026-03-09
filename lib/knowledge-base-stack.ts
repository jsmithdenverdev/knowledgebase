import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BundlingOptions, NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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

    const nodeRuntime = lambda.Runtime.NODEJS_24_X;
    const sharedNodeBundling: BundlingOptions = {
      minify: true,
      sourceMap: false,
      sourcesContent: false,
      format: OutputFormat.CJS,
      target: 'node24',
      externalModules: ['@aws-sdk/*', 'aws-lambda'],
    };
    const defaultChatModelId = 'anthropic.claude-3-haiku-20240307-v1:0';
    const defaultAgentPrompt = `You are an enterprise knowledge base assistant. Use the provided context to answer questions precisely, cite relevant policies when possible, and state "I don't know" if the answer is not in the knowledge base.`;
    const chatModelIdParam = new cdk.CfnParameter(this, 'ChatModelId', {
      type: 'String',
      default: '',
      description:
        'Bedrock model identifier used for chat streaming (e.g., anthropic.claude-3-haiku-20240307-v1:0). Leave blank to use the default.',
    });
    const hasChatModelId = new cdk.CfnCondition(this, 'HasChatModelId', {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(chatModelIdParam.valueAsString, '')),
    });
    const resolvedChatModelId = cdk.Token.asString(
      cdk.Fn.conditionIf(
        hasChatModelId.logicalId,
        chatModelIdParam.valueAsString,
        defaultChatModelId
      )
    );

    const agentSystemPromptParam = new cdk.CfnParameter(this, 'AgentSystemPrompt', {
      type: 'String',
      default: '',
      description:
        'Optional override for the Bedrock Agent instructions. Leave blank to use the default enterprise knowledge base prompt.',
    });

    const hasAgentSystemPrompt = new cdk.CfnCondition(this, 'HasAgentSystemPrompt', {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(agentSystemPromptParam.valueAsString, '')
      ),
    });

    const resolvedAgentSystemPrompt = cdk.Token.asString(
      cdk.Fn.conditionIf(
        hasAgentSystemPrompt.logicalId,
        agentSystemPromptParam.valueAsString,
        defaultAgentPrompt
      )
    );

    console.log(
      `[KnowledgeBaseStack] Creating primary S3 bucket knowledge-base-docs-${this.account}-${this.region}`
    );
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
          'bedrock:InvokeAgent',
          'bedrock:InvokeAgentWithResponseStream',
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

    const agentRole = new iam.Role(this, 'AgentServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description:
        'Execution role for the Bedrock agent to invoke models and retrieve knowledge base context.',
    });

    agentRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
        ],
        resources: ['*'],
      })
    );

    knowledgeBaseBucket.grantRead(agentRole);

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

    console.log(
      `[KnowledgeBaseStack] Configuring Bedrock agent ${this.stackName}-agent with knowledge base ${knowledgeBase.knowledgeBaseId}`
    );
    const chatAgent = new bedrock.CfnAgent(this, 'KnowledgeBaseAgent', {
      agentName: `${this.stackName}-agent`,
      agentResourceRoleArn: agentRole.roleArn,
      autoPrepare: true,
      foundationModel: resolvedChatModelId,
      instruction: resolvedAgentSystemPrompt,
      idleSessionTtlInSeconds: 900,
      knowledgeBases: [
        {
          description: 'Primary knowledge base for enterprise chat',
          knowledgeBaseId: knowledgeBase.knowledgeBaseId,
          knowledgeBaseState: 'ENABLED',
        },
      ],
      // Future enhancement: guardrails & tool definitions will be added here.
    });

    chatAgent.addDependency(dataSource);

    const ingestLambda = new NodejsFunction(this, 'IngestLambda', {
      role: lambdaRole,
      runtime: nodeRuntime,
      bundling: sharedNodeBundling,
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
      runtime: nodeRuntime,
      bundling: sharedNodeBundling,
      entry: 'src/handlers/chat.ts',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        AGENT_ID: chatAgent.attrAgentId,
        AGENT_ALIAS_ID: 'TSTALIASID',
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

    new cdk.CfnOutput(this, 'ChatAgentId', {
      value: chatAgent.attrAgentId,
      description: 'Agent ID used for PrepareAgent and InvokeAgent calls',
    });
  }
}
