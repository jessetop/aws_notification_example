/**
 * Rules engine: CloudWatch Logs subscription filters deliver batches of log lines
 * here. Each line is parsed and checked against the alert rules in the config
 * table. Matches are counted per (rule, host, fixed window) in DynamoDB, and
 * when a count crosses its rule's threshold an alert is published to the alarm
 * topic (→ SQS → Step Functions), exactly once per window.
 */
import { gunzipSync } from 'node:zlib';
import type { CloudWatchLogsEvent, CloudWatchLogsDecodedData } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, getRules } from './shared/ddb';
import {
  crossedThreshold,
  logTypeFromGroup,
  parseLine,
  ruleMatches,
  RULE_ALERT_SOURCE,
  windowBucket,
  type AlertRule,
  type RuleAlert,
} from './shared/logs';

const sns = new SNSClient({});
const STATE_TABLE = process.env.RULE_STATE_TABLE!;
const TOPIC_ARN = process.env.ALARM_TOPIC_ARN!;
const GROUP_PREFIX = process.env.LOG_GROUP_PREFIX!;
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'App/Notifications';
const RULES_TTL_MS = 30_000;
const MAX_SAMPLES = 3;

let cache: { rules: AlertRule[]; at: number } | undefined;
async function rules(): Promise<AlertRule[]> {
  if (!cache || Date.now() - cache.at > RULES_TTL_MS) cache = { rules: await getRules(), at: Date.now() };
  return cache.rules;
}

interface Hit {
  rule: AlertRule;
  bucket: number;
  count: number;
  samples: string[];
}

export const handler = async (event: CloudWatchLogsEvent) => {
  const data: CloudWatchLogsDecodedData = JSON.parse(gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'));
  if (data.messageType !== 'DATA_MESSAGE') return { skipped: data.messageType };
  const type = logTypeFromGroup(data.logGroup, GROUP_PREFIX);
  if (!type) return { skipped: `unknown log group ${data.logGroup}` };
  const host = data.logStream;

  const active = (await rules()).filter((r) => r.enabled && r.logTypes.includes(type));
  const hits = new Map<string, Hit>();
  for (const ev of data.logEvents) {
    const parsed = parseLine(type, ev.message);
    for (const rule of active) {
      if (!ruleMatches(rule, type, parsed, ev.message)) continue;
      const bucket = windowBucket(ev.timestamp, rule.windowMinutes);
      const k = `${rule.id}|${bucket}`;
      const hit = hits.get(k) ?? { rule, bucket, count: 0, samples: [] };
      hit.count++;
      if (hit.samples.length < MAX_SAMPLES) hit.samples.push(ev.message.slice(0, 300));
      hits.set(k, hit);
    }
  }

  // One EMF line per rule for the dashboard (dimension: Rule only, so 100 hosts don't multiply metric cost).
  const perRule = new Map<string, number>();
  for (const h of hits.values()) perRule.set(h.rule.id, (perRule.get(h.rule.id) ?? 0) + h.count);
  for (const [rule, n] of perRule) {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [['Rule']], Metrics: [{ Name: 'RuleMatches', Unit: 'Count' }] }],
        },
        Rule: rule,
        RuleMatches: n,
      }),
    );
  }

  let alerts = 0;
  for (const h of hits.values()) {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: STATE_TABLE,
        Key: { pk: `${h.rule.id}#${host}`, windowStart: h.bucket },
        UpdateExpression: 'ADD #c :n SET #ttl = :ttl',
        ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':n': h.count, ':ttl': Math.floor(h.bucket / 1000) + 86_400 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const next = Number(res.Attributes?.count ?? h.count);
    if (!crossedThreshold(next - h.count, next, h.rule.threshold)) continue;

    const alert: RuleAlert = {
      source: RULE_ALERT_SOURCE,
      ruleId: h.rule.id,
      ruleName: h.rule.name,
      host,
      severity: h.rule.severity,
      count: next,
      threshold: h.rule.threshold,
      windowMinutes: h.rule.windowMinutes,
      windowStart: new Date(h.bucket).toISOString(),
      detectedAt: new Date().toISOString(),
      logTypes: h.rule.logTypes,
      terms: h.rule.terms ?? [],
      eventIds: h.rule.eventIds ?? [],
      minLevel: h.rule.minLevel,
      samples: h.samples,
    };
    await sns.send(new PublishCommand({ TopicArn: TOPIC_ARN, Message: JSON.stringify(alert) }));
    console.log(JSON.stringify({ msg: 'rule alert', rule: h.rule.id, host, count: next, threshold: h.rule.threshold }));
    alerts++;
  }
  return { lines: data.logEvents.length, matches: [...perRule.values()].reduce((a, b) => a + b, 0), alerts };
};
