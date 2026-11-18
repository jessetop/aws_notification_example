import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import {
  BUDGET_ALERT_EMAIL,
  BUDGET_FORECAST_ALERT_PERCENTS,
  BUDGET_MONTHLY_USD,
  DEDUP_WINDOW_MINUTES,
  DEFAULT_RULES,
  LOG_GROUP_PREFIX,
  NOTIFY_EMAIL,
  PROJECT,
  SLACK_PLACEHOLDER,
} from './config';
import { Dashboard } from './dashboard';
import { Detection } from './detection';
import { LogAnalytics } from './log-analytics';
import { createSiteBucket, OperatorUi } from './operator-ui';
import { Workflow } from './workflow';

/** Marshal a plain object into DynamoDB JSON (enough for the seed rows). */
function ddbJson(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(ddbJson) };
  if (v && typeof v === 'object') {
    return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ddbJson(x)])) };
  }
  return { NULL: true };
}
const ddbItem = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ddbJson(v)]));

export class NotificationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Phase 1: foundation ----------
    // Public subnets only: hosts get public IPs with zero inbound rules. No NAT, no endpoints.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const notificationsTable = new dynamodb.Table(this, 'Notifications', {
      partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    notificationsTable.addGlobalSecondaryIndex({
      indexName: 'RecentIndex',
      partitionKey: { name: 'gsiPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
    });

    const configTable = new dynamodb.Table(this, 'Config', {
      partitionKey: { name: 'entity', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Seed rows once (onCreate only), so UI edits survive later deploys.
    const seed = [
      { entity: 'channel', key: 'email', enabled: true, config: { fromAddress: NOTIFY_EMAIL, toAddresses: [NOTIFY_EMAIL] } },
      { entity: 'channel', key: 'slack', enabled: false, config: { webhookUrl: SLACK_PLACEHOLDER } },
      { entity: 'channel', key: 'sms', enabled: true, config: { simulate: true, phoneNumber: '' } },
      { entity: 'channel', key: 'website', enabled: true, config: {} },
      { entity: 'settings', key: 'dedup', windowMinutes: DEDUP_WINDOW_MINUTES },
    ];
    new cr.AwsCustomResource(this, 'SeedConfig', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: { [configTable.tableName]: seed.map((item) => ({ PutRequest: { Item: ddbItem(item) } })) },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${PROJECT}-config-seed-v1`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [configTable.tableArn] }),
      installLatestAwsSdk: false,
    });

    // Default alert rules, seeded once in their own resource so stacks deployed before
    // rules existed get them too. Edits made in the UI are never overwritten.
    new cr.AwsCustomResource(this, 'SeedRules', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [configTable.tableName]: DEFAULT_RULES.map(({ id: key, ...rule }) => ({
              PutRequest: { Item: ddbItem({ entity: 'rule', key, ...rule }) },
            })),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${PROJECT}-rules-seed-v1`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [configTable.tableArn] }),
      installLatestAwsSdk: false,
    });

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Notification demo alarms' });
    const dlq = new sqs.Queue(this, 'AlarmDlq', { retentionPeriod: Duration.days(14), enforceSSL: true });
    const queue = new sqs.Queue(this, 'AlarmQueue', {
      visibilityTimeout: Duration.seconds(180), // 6× the trigger Lambda timeout
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });
    alarmTopic.addSubscription(new subs.SqsSubscription(queue));

    // SES sandbox: the address must click the verification link once after deploy.
    new ses.EmailIdentity(this, 'NotifyEmailIdentity', { identity: ses.Identity.email(NOTIFY_EMAIL) });

    const siteBucket = createSiteBucket(this);

    // Project budget: everything tagged Project=notification-demo, forecast-based alerts only.
    // NOTE: this is a linked account; the payer account must activate the "Project"
    // cost-allocation tag before tagged spend appears in this budget.
    new budgets.CfnBudget(this, 'ProjectBudget', {
      budget: {
        budgetName: `${PROJECT}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: BUDGET_MONTHLY_USD, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Project$${PROJECT}`] },
      },
      notificationsWithSubscribers: BUDGET_FORECAST_ALERT_PERCENTS.map((pct) => ({
        notification: {
          notificationType: 'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold: pct,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: BUDGET_ALERT_EMAIL }],
      })),
    });

    // ---------- Phases 2–6 ----------
    const logAnalytics = new LogAnalytics(this, 'LogAnalytics', { alarmTopic, configTable });
    const detection = new Detection(this, 'Detection', { vpc, groups: logAnalytics.groups });
    const workflow = new Workflow(this, 'Workflow', { queue, notificationsTable, configTable, siteBucket });
    const ui = new OperatorUi(this, 'OperatorUi', { siteBucket, notificationsTable, configTable });

    // ---------- Phase 7 ----------
    const dash = new Dashboard(this, 'Observability', {
      hosts: detection.hosts,
      logGroups: Object.values(logAnalytics.groups),
      stateMachine: workflow.stateMachine,
      queue,
      dlq,
      functions: { ...workflow.functions, rulesEngine: logAnalytics.rulesEngine },
    });

    // ---------- Outputs ----------
    const out = (id: string, value: string, description: string) => new CfnOutput(this, id, { value, description });
    out('OperatorUiUrl', `${siteBucket.bucketWebsiteUrl}/index.html`, 'Operator UI (alerts, fleet logs, alert rules)');
    out('PublicNoticesUrl', `${siteBucket.bucketWebsiteUrl}/notices.html`, 'Public notices page');
    out('ApiUrl', ui.api.apiEndpoint, 'Operator API base URL');
    out('OperatorKeySecretName', ui.operatorKey.secretName, 'Secrets Manager secret holding the operator key');
    out('StateMachineArn', workflow.stateMachine.stateMachineArn, 'Notification workflow');
    out(
      'StateMachineConsoleUrl',
      `https://${this.region}.console.aws.amazon.com/states/home?region=${this.region}#/statemachines/view/${workflow.stateMachine.stateMachineArn}`,
      'Step Functions executions',
    );
    out(
      'DashboardUrl',
      `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dash.dashboard.dashboardName}`,
      'CloudWatch dashboard',
    );
    out('AlarmTopicArn', alarmTopic.topicArn, 'Alarm SNS topic (publish a test alarm here)');
    out('LogGroupPrefix', LOG_GROUP_PREFIX, 'Fleet log groups: one per log type, one stream per host');
    out('DlqUrl', dlq.queueUrl, 'Dead-letter queue');
    for (const h of detection.hosts) out(`InstanceId${h.id.replace(/[^A-Za-z0-9]/g, '')}`, h.instance.instanceId, `${h.id} instance`);
  }
}
