/** Phases 3–5: trigger Lambda, processing Lambdas, delivery channels, Step Functions workflow. */
import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import {
  BEDROCK_INFERENCE_PROFILE_ID,
  BEDROCK_MODEL_ID,
  BEDROCK_ROUTED_REGIONS,
  DELIVERY_METRIC_NAMESPACE,
  LOG_GROUP_PREFIX,
  PROJECT,
} from './config';

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');

export interface WorkflowProps {
  queue: sqs.IQueue;
  notificationsTable: dynamodb.ITable;
  configTable: dynamodb.ITable;
  siteBucket: s3.IBucket;
}

export function makeFunction(
  scope: Construct,
  id: string,
  entry: string,
  opts: { env?: Record<string, string>; timeout?: Duration; bundleAwsSdk?: boolean } = {},
): nodejs.NodejsFunction {
  return new nodejs.NodejsFunction(scope, id, {
    entry: path.join(LAMBDA_DIR, entry),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 256,
    timeout: opts.timeout ?? Duration.seconds(30),
    environment: opts.env,
    bundling: { minify: true, sourceMap: false, bundleAwsSDK: opts.bundleAwsSdk ?? false },
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
  });
}

export class Workflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly functions: Record<string, nodejs.NodejsFunction> = {};

  constructor(scope: Construct, id: string, props: WorkflowProps) {
    super(scope, id);
    const { region, account } = Stack.of(this);
    const tableEnv = {
      NOTIFICATIONS_TABLE: props.notificationsTable.tableName,
      CONFIG_TABLE: props.configTable.tableName,
    };

    // ---------- Lambdas ----------
    const dedupFn = makeFunction(this, 'Dedup', 'dedup.ts', { env: tableEnv });
    props.configTable.grantReadData(dedupFn);
    dedupFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [props.notificationsTable.tableArn] }),
    );

    // On-demand Bedrock usage can't be tagged, but calls made through an *application*
    // inference profile can — this puts Bedrock spend under the Project cost tag.
    const systemProfileArn = `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_INFERENCE_PROFILE_ID}`;
    const appProfile = new bedrock.CfnApplicationInferenceProfile(this, 'HaikuProfile', {
      inferenceProfileName: `${PROJECT}-haiku-4-5`,
      description: 'Tagged Claude Haiku 4.5 profile for notification-demo cost tracking',
      modelSource: { copyFrom: systemProfileArn },
    });
    const bedrockPolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        appProfile.attrInferenceProfileArn,
        systemProfileArn,
        ...BEDROCK_ROUTED_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${BEDROCK_MODEL_ID}`),
      ],
    });
    const aiEnv = { MODEL_ID: appProfile.attrInferenceProfileArn };
    const summarizeFn = makeFunction(this, 'Summarize', 'summarize.ts', { env: aiEnv, timeout: Duration.seconds(45) });
    const guardrailFn = makeFunction(this, 'Guardrail', 'guardrail.ts', { env: aiEnv, timeout: Duration.seconds(45) });
    summarizeFn.addToRolePolicy(bedrockPolicy);
    guardrailFn.addToRolePolicy(bedrockPolicy);

    const getConfigFn = makeFunction(this, 'GetConfig', 'get-config.ts', { env: tableEnv });
    getConfigFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [props.configTable.tableArn] }),
    );

    const slackFn = makeFunction(this, 'Slack', 'slack.ts', { timeout: Duration.seconds(15) });
    const smsFn = makeFunction(this, 'Sms', 'sms.ts');
    smsFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] })); // SMS publish has no resource ARN
    const websiteFn = makeFunction(this, 'Website', 'website.ts', {
      env: { SITE_BUCKET: props.siteBucket.bucketName },
      bundleAwsSdk: true, // needs S3 conditional-write support regardless of runtime SDK version
    });
    props.siteBucket.grantRead(websiteFn, 'notices/*');
    props.siteBucket.grantPut(websiteFn, 'notices/*');

    const historyFn = makeFunction(this, 'WriteHistory', 'write-history.ts', {
      env: { ...tableEnv, DELIVERY_METRIC_NAMESPACE },
    });
    historyFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [props.notificationsTable.tableArn] }),
    );

    Object.assign(this.functions, {
      dedup: dedupFn,
      summarize: summarizeFn,
      guardrail: guardrailFn,
      getConfig: getConfigFn,
      slack: slackFn,
      sms: smsFn,
      website: websiteFn,
      writeHistory: historyFn,
    });

    // ---------- State helpers ----------
    const invoke = (stateId: string, fn: lambda.IFunction, resultPath: string, payload?: sfn.TaskInput) => {
      const t = new tasks.LambdaInvoke(this, stateId, {
        lambdaFunction: fn,
        payload,
        payloadResponseOnly: true,
        resultPath,
      });
      t.addRetry({ errors: ['States.TaskFailed'], maxAttempts: 2, interval: Duration.seconds(2), backoffRate: 2 });
      return t;
    };

    const recordHistory = (status: string, idSuffix: string) =>
      new sfn.Pass(this, `Status ${idSuffix}`, { result: sfn.Result.fromString(status), resultPath: '$.status' }).next(
        invoke(`Write history ${idSuffix}`, historyFn, '$.history'),
      );

    const channelBranch = (name: string, task: sfn.TaskStateBase) => {
      const failed = new sfn.Pass(this, `${name} failed`, {
        parameters: { channel: name, status: 'FAILED', 'error.$': '$.Cause' },
      });
      task.addCatch(failed, { resultPath: '$' });
      return new sfn.Choice(this, `${name} enabled?`)
        .when(sfn.Condition.booleanEquals(`$.config.${name}.enabled`, true), task)
        .otherwise(new sfn.Pass(this, `${name} disabled`, { parameters: { channel: name, status: 'DISABLED' } }));
    };

    // ---------- Channels ----------
    const emailTask = new tasks.CallAwsService(this, 'Send email', {
      service: 'sesv2',
      action: 'sendEmail',
      iamAction: 'ses:SendEmail',
      iamResources: [`arn:aws:ses:${region}:${account}:identity/*`],
      parameters: {
        FromEmailAddress: sfn.JsonPath.stringAt('$.config.email.config.fromAddress'),
        Destination: { ToAddresses: sfn.JsonPath.listAt('$.config.email.config.toAddresses') },
        Content: {
          Simple: {
            Subject: { Data: sfn.JsonPath.format('[{}] City IT notice: {}', sfn.JsonPath.stringAt('$.severity'), sfn.JsonPath.stringAt('$.alarmName')) },
            // Summary + links to the matching logs (operator UI and CloudWatch Logs Insights).
            Body: { Text: { Data: sfn.JsonPath.stringAt('$.ai.internalBody') } },
          },
        },
      },
      resultSelector: { channel: 'email', status: 'SENT', 'messageId.$': '$.MessageId' },
    });
    emailTask.addRetry({ errors: ['SesV2.TooManyRequestsException'], maxAttempts: 3, interval: Duration.seconds(2), backoffRate: 2 });

    const common = {
      'summary.$': '$.ai.summary',
      'alarmName.$': '$.alarmName',
      'severity.$': '$.severity',
    };
    const channelInvoke = (stateId: string, fn: lambda.IFunction, extra: Record<string, string>) => {
      const t = new tasks.LambdaInvoke(this, stateId, {
        lambdaFunction: fn,
        payload: sfn.TaskInput.fromObject({ ...common, ...extra }),
        payloadResponseOnly: true,
      });
      t.addRetry({ errors: ['States.TaskFailed'], maxAttempts: 2, interval: Duration.seconds(2), backoffRate: 2 });
      return t;
    };

    const deliver = new sfn.Parallel(this, 'Deliver to channels', { resultPath: '$.channels' })
      .branch(channelBranch('email', emailTask))
      .branch(channelBranch('slack', channelInvoke('Post to Slack', slackFn, { 'config.$': '$.config.slack.config', 'links.$': '$.links' })))
      .branch(channelBranch('sms', channelInvoke('Send SMS', smsFn, { 'config.$': '$.config.sms.config' })))
      .branch(
        channelBranch(
          'website',
          channelInvoke('Update website', websiteFn, {
            'eventType.$': '$.eventType',
            'sourceId.$': '$.sourceId',
            'stateChangeTime.$': '$.stateChangeTime',
          }),
        ),
      );

    // ---------- Main flow ----------
    const main = invoke('Check duplicate', dedupFn, '$.dedup').next(
      new sfn.Choice(this, 'Duplicate?')
        .when(
          sfn.Condition.booleanEquals('$.dedup.duplicate', true),
          recordHistory('SKIPPED_DUPLICATE', 'duplicate').next(new sfn.Succeed(this, 'Skipped (duplicate)')),
        )
        .otherwise(
          invoke('Summarize with Bedrock', summarizeFn, '$.ai')
            .next(
              invoke(
                'Guardrail check',
                guardrailFn,
                '$.guardrail',
                sfn.TaskInput.fromObject({ 'summary.$': '$.ai.summary', 'fallback.$': '$.ai.fallback' }),
              ),
            )
            .next(
              new sfn.Choice(this, 'Appropriate?')
                .when(
                  sfn.Condition.booleanEquals('$.guardrail.appropriate', false),
                  recordHistory('SKIPPED_GUARDRAIL', 'guardrail').next(new sfn.Succeed(this, 'Withheld (guardrail)')),
                )
                .otherwise(
                  invoke('Get channel config', getConfigFn, '$.config', sfn.TaskInput.fromObject({}))
                    .next(deliver)
                    .next(recordHistory('SENT', 'sent'))
                    .next(new sfn.Succeed(this, 'Delivered')),
                ),
            ),
        ),
    );

    // Single-branch Parallel so one Catch covers every state above.
    const processNotification = new sfn.Parallel(this, 'Process notification', { outputPath: '$[0]' }).branch(main);
    processNotification.addCatch(
      recordHistory('FAILED', 'failed').next(new sfn.Fail(this, 'Failed', { error: 'NotificationFailed', cause: 'See history record' })),
      { resultPath: '$.error' },
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `${PROJECT}-workflow`,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(processNotification),
      timeout: Duration.minutes(5),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // ---------- Trigger: SQS → StartExecution ----------
    const triggerFn = makeFunction(this, 'Trigger', 'trigger.ts', {
      env: {
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
        OPERATOR_UI_URL: props.siteBucket.bucketWebsiteUrl,
        LOG_GROUP_PREFIX,
      },
    });
    this.stateMachine.grantStartExecution(triggerFn);
    triggerFn.addEventSource(new SqsEventSource(props.queue, { batchSize: 1, reportBatchItemFailures: true }));
    this.functions.trigger = triggerFn;
  }
}
