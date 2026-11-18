/**
 * Fleet log analytics: one log group per log type (each host is a stream), the
 * rules-engine Lambda that evaluates operator-defined alert rules against every
 * shipped line, and the subscription filters that feed it.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { LOG_GROUP_PREFIX, LOG_TYPES, METRIC_NAMESPACE, type LogType } from './config';
import { makeFunction } from './workflow';

export interface LogAnalyticsProps {
  alarmTopic: sns.ITopic;
  configTable: dynamodb.ITable;
}

/** Only lines that can matter reach the rules engine: Apache requests that returned 4xx/5xx. */
function subscriptionPattern(type: LogType): logs.IFilterPattern {
  if (type === 'apache-access') {
    // Combined log format: ip ident user [time] "request" status bytes "referer" "agent"
    return logs.FilterPattern.spaceDelimited('ip', 'ident', 'user', 'timestamp', 'request', 'status_code', 'bytes', 'referer', 'agent')
      .whereNumber('status_code', '>=', 400);
  }
  return logs.FilterPattern.allEvents();
}

export class LogAnalytics extends Construct {
  readonly groups = {} as Record<LogType, logs.LogGroup>;
  readonly rulesEngine: nodejs.NodejsFunction;
  readonly ruleStateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LogAnalyticsProps) {
    super(scope, id);

    for (const type of LOG_TYPES) {
      this.groups[type] = new logs.LogGroup(this, `Logs-${type}`, {
        logGroupName: `${LOG_GROUP_PREFIX}${type}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    }

    // Per (rule, host, window) match counters; expire a day after the window.
    this.ruleStateTable = new dynamodb.Table(this, 'RuleState', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'windowStart', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.rulesEngine = makeFunction(this, 'RulesEngine', 'rules-engine.ts', {
      env: {
        CONFIG_TABLE: props.configTable.tableName,
        RULE_STATE_TABLE: this.ruleStateTable.tableName,
        ALARM_TOPIC_ARN: props.alarmTopic.topicArn,
        LOG_GROUP_PREFIX,
        METRIC_NAMESPACE,
      },
      timeout: Duration.seconds(60),
    });
    this.rulesEngine.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [props.configTable.tableArn] }),
    );
    this.rulesEngine.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [this.ruleStateTable.tableArn] }),
    );
    props.alarmTopic.grantPublish(this.rulesEngine);

    const destination = new destinations.LambdaDestination(this.rulesEngine);
    for (const type of LOG_TYPES) {
      new logs.SubscriptionFilter(this, `ToRules-${type}`, {
        logGroup: this.groups[type],
        destination,
        filterPattern: subscriptionPattern(type),
      });
    }
  }
}
