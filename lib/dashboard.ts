/** Phase 7: CloudWatch dashboard tying detection and delivery together. */
import { Duration } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { PROBLEM_REGEX } from '../lambda/shared/logs';
import { DELIVERY_METRIC_NAMESPACE, METRIC_NAMESPACE, PROJECT } from './config';
import type { HostResources } from './detection';

export interface DashboardProps {
  hosts: HostResources[];
  logGroups: logs.ILogGroup[];
  stateMachine: sfn.StateMachine;
  queue: sqs.IQueue;
  dlq: sqs.IQueue;
  functions: Record<string, lambda.IFunction>;
}

const FIVE_MIN = Duration.minutes(5);

export class Dashboard extends Construct {
  readonly dashboard: cw.Dashboard;

  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);
    const d = (this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `${PROJECT}`,
      defaultInterval: Duration.hours(3),
    }));

    const logGroupNames = props.logGroups.map((g) => g.logGroupName);
    d.addWidgets(
      new cw.TextWidget({
        markdown:
          '# Notification system\nHosts → CloudWatch Agent → fleet log groups (one per log type, stream per host) → rules engine (operator-defined rules) → SNS → SQS → Step Functions (dedup → Bedrock summary → guardrail → channels). Query the logs from the operator UI **Logs** tab.',
        width: 24,
        height: 2,
      }),
    );

    d.addWidgets(
      new cw.GraphWidget({
        title: 'Rule matches by rule (rules engine)',
        width: 12,
        height: 6,
        stacked: true,
        left: [
          new cw.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},Rule} MetricName="RuleMatches"', 'Sum', 300)`,
            label: '',
            period: FIVE_MIN,
          }),
        ],
      }),
      new cw.LogQueryWidget({
        title: 'Problem lines by host (all fleet logs)',
        width: 12,
        height: 6,
        logGroupNames,
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: [`filter @message like /${PROBLEM_REGEX}/`, 'stats count(*) as problems by @logStream as host', 'sort problems desc', 'limit 20'],
      }),
    );

    d.addWidgets(
      new cw.LogQueryWidget({
        title: 'Recent problems across the fleet',
        width: 24,
        height: 7,
        logGroupNames,
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, @logStream as host, @message',
          `filter @message like /${PROBLEM_REGEX}/`,
          'sort @timestamp desc',
          'limit 50',
        ],
      }),
    );

    d.addWidgets(
      new cw.GraphWidget({
        title: 'Workflow executions',
        width: 8,
        height: 6,
        left: [
          props.stateMachine.metricStarted({ period: FIVE_MIN, label: 'Started' }),
          props.stateMachine.metricSucceeded({ period: FIVE_MIN, label: 'Succeeded' }),
          props.stateMachine.metricFailed({ period: FIVE_MIN, label: 'Failed', color: cw.Color.RED }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Deliveries by channel (SENT / SIMULATED)',
        width: 8,
        height: 6,
        stacked: true,
        left: [
          new cw.MathExpression({
            expression: `SEARCH('{${DELIVERY_METRIC_NAMESPACE},Channel,Status} MetricName="Delivery" (Status="SENT" OR Status="SIMULATED")', 'Sum', 300)`,
            label: '',
            period: FIVE_MIN,
          }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Delivery failures / skips by channel',
        width: 8,
        height: 6,
        stacked: true,
        left: [
          new cw.MathExpression({
            expression: `SEARCH('{${DELIVERY_METRIC_NAMESPACE},Channel,Status} MetricName="Delivery" (Status="FAILED" OR Status="SKIPPED_MISCONFIGURED")', 'Sum', 300)`,
            label: '',
            period: FIVE_MIN,
          }),
        ],
      }),
    );

    d.addWidgets(
      new cw.GraphWidget({
        title: 'Queue depth (buffer + DLQ)',
        width: 8,
        height: 6,
        left: [props.queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), label: 'Queue' })],
        right: [
          props.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), label: 'DLQ', color: cw.Color.RED }),
        ],
      }),
      new cw.GraphWidget({
        title: 'Lambda errors',
        width: 8,
        height: 6,
        stacked: true,
        left: Object.entries(props.functions).map(([name, fn]) => fn.metricErrors({ period: FIVE_MIN, label: name })),
      }),
      new cw.GraphWidget({
        title: 'EC2 CPU utilization',
        width: 8,
        height: 6,
        left: props.hosts.map(
          (h) =>
            new cw.Metric({
              namespace: 'AWS/EC2',
              metricName: 'CPUUtilization',
              dimensionsMap: { InstanceId: h.instance.instanceId },
              statistic: 'Average',
              period: FIVE_MIN,
              label: h.id,
            }),
        ),
      }),
    );
  }
}
