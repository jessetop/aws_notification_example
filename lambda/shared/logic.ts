/**
 * Pure logic shared by the Lambdas. No AWS SDK imports here, so it can be
 * unit-tested without mocks.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './errors';
import { LOG_TYPES, RULE_ALERT_SOURCE, scopeForAlert, type LogLinks, type LogScope, type RuleAlert } from './logs';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

export const SEVERITY_BY_EVENT: Record<string, Severity> = {
  CveHits: 'HIGH',
  AuthFail: 'MEDIUM',
  AppException: 'LOW',
};

export interface WorkflowInput {
  alarmName: string;
  state: string;
  stateChangeTime: string;
  reason: string;
  trigger: { metricName: string; namespace: string; dimensions: Record<string, string> };
  sourceId: string;
  eventType: string;
  severity: Severity;
  receivedAt: number;
  rawEvent: string;
  /** Which logs to show for this alert (host, log types, terms, time window). */
  logs: LogScope;
  /** Added by the trigger Lambda: deep links into the operator UI and CloudWatch. */
  links?: LogLinks;
  /** Rule alerts only: a few matching log lines, for the summarizer. */
  samples?: string[];
}

function parseRuleAlert(a: RuleAlert, rawEvent: string, receivedAt: number): WorkflowInput {
  if (typeof a.ruleId !== 'string' || typeof a.host !== 'string' || !Array.isArray(a.logTypes)) {
    throw new Error('Malformed rule alert');
  }
  return {
    alarmName: a.ruleName || a.ruleId,
    state: 'ALARM',
    stateChangeTime: a.detectedAt,
    reason: `${a.count} matching log lines within ${a.windowMinutes} min (threshold ${a.threshold})`,
    trigger: { metricName: a.ruleId, namespace: 'RulesEngine', dimensions: { host: a.host } },
    sourceId: `host:${a.host}`,
    eventType: a.ruleId,
    severity: (['LOW', 'MEDIUM', 'HIGH'] as const).includes(a.severity) ? a.severity : 'MEDIUM',
    receivedAt,
    rawEvent,
    logs: scopeForAlert({ ...a, terms: a.terms ?? [], eventIds: a.eventIds ?? [] }),
    samples: (a.samples ?? []).slice(0, 5).map((s) => String(s).slice(0, 300)),
  };
}

/**
 * Parse one SQS record body (an SNS notification wrapping a CloudWatch alarm or
 * a rules-engine alert) into the Step Functions input contract. Throws on
 * anything unparseable so the record is retried and eventually lands in the DLQ.
 */
export function parseAlarmRecord(body: string, receivedAt: number): WorkflowInput {
  const envelope = JSON.parse(body);
  const rawEvent: string = typeof envelope.Message === 'string' ? envelope.Message : body;
  const alarm = JSON.parse(rawEvent);
  if (alarm?.source === RULE_ALERT_SOURCE) return parseRuleAlert(alarm as RuleAlert, rawEvent, receivedAt);
  if (!alarm || typeof alarm.AlarmName !== 'string' || !alarm.Trigger) {
    throw new Error('Not a CloudWatch alarm payload');
  }
  const dims: Record<string, string> = {};
  for (const d of alarm.Trigger.Dimensions ?? []) {
    if (d && typeof d.name === 'string') dims[d.name] = String(d.value);
  }
  const metricName: string = alarm.Trigger.MetricName ?? 'Unknown';
  const host = dims.host ?? 'unknown';
  const changed = Date.parse(alarm.StateChangeTime ?? '');
  const at = Number.isFinite(changed) ? changed : receivedAt;
  return {
    alarmName: alarm.AlarmName,
    state: alarm.NewStateValue ?? 'ALARM',
    stateChangeTime: alarm.StateChangeTime ?? new Date(receivedAt).toISOString(),
    logs: {
      hosts: host === 'unknown' ? [] : [host],
      logTypes: [...LOG_TYPES],
      terms: [],
      problemsOnly: true,
      from: new Date(at - 15 * 60_000).toISOString(),
      to: new Date(at + 5 * 60_000).toISOString(),
    },
    reason: alarm.NewStateReason ?? '',
    trigger: { metricName, namespace: alarm.Trigger.Namespace ?? '', dimensions: dims },
    sourceId: `host:${host}`,
    eventType: metricName,
    severity: SEVERITY_BY_EVENT[metricName] ?? 'MEDIUM',
    receivedAt,
    rawEvent,
  };
}

export function dedupHash(sourceId: string, eventType: string, severity: string): string {
  return createHash('sha256').update(`${sourceId}:${eventType}:${severity}`).digest('hex').slice(0, 16);
}

export function windowStart(now: number, windowMinutes: number): number {
  return now - windowMinutes * 60_000;
}

const EVENT_DESCRIPTIONS: Record<string, string> = {
  CveHits: 'repeated vulnerability-scan (CVE) probes',
  AuthFail: 'a spike in failed sign-in attempts',
  AppException: 'a burst of application errors',
};

/** Deterministic summary used when Bedrock is unavailable. */
export function templatedSummary(
  e: Pick<WorkflowInput, 'eventType' | 'severity' | 'sourceId' | 'stateChangeTime'> & { alarmName?: string },
): string {
  const what =
    EVENT_DESCRIPTIONS[e.eventType] ?? `activity matching the "${e.alarmName ?? e.eventType}" monitoring rule`;
  const host = e.sourceId.replace(/^host:/, '');
  const action =
    e.severity === 'HIGH'
      ? 'The IT security team has been alerted and is investigating; no action is needed from residents.'
      : 'Staff are monitoring the situation; services remain available.';
  return `${e.severity} alert: monitoring detected ${what} on server ${host} at ${e.stateChangeTime}. ${action}`;
}

const RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'contains what looks like an AWS access key' },
  { re: /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/i, reason: 'contains a credential assignment' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'contains a private key' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, reason: 'contains what looks like a US SSN' },
  { re: /\b(fuck|shit|bitch|asshole|cunt)\b/i, reason: 'contains profanity' },
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    // Epoch-millisecond timestamps are 13 digits starting with 1; skip them.
    if (digits.length === 13 && digits.startsWith('1')) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

/** Deterministic pre-check; returns a reason when the text must be withheld. */
export function ruleCheck(text: string): { appropriate: boolean; reason: string } {
  for (const r of RULES) if (r.re.test(text)) return { appropriate: false, reason: `Rule check: ${r.reason}` };
  if (containsCardNumber(text)) return { appropriate: false, reason: 'Rule check: contains what looks like a payment card number' };
  if (text.trim().length < 10) return { appropriate: false, reason: 'Rule check: summary is empty or too short' };
  return { appropriate: true, reason: 'Rule check passed' };
}

/** Extract `{appropriate, reason}` from a model reply that should be JSON. */
export function parseGuardrailReply(reply: string): { appropriate: boolean; reason: string } | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.appropriate !== 'boolean') return null;
    return { appropriate: o.appropriate, reason: String(o.reason ?? '') };
  } catch {
    return null;
  }
}

export function isRealSlackWebhook(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://hooks.slack.com/') && !url.includes('REPLACE_ME');
}

export function truncateSms(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------- Operator API validation ----------

export type ChannelName = 'email' | 'slack' | 'sms' | 'website';
export const CHANNEL_NAMES: ChannelName[] = ['email', 'slack', 'sms', 'website'];

const EDITABLE_CONFIG: Record<ChannelName, string[]> = {
  email: [],
  slack: ['webhookUrl'],
  sms: ['simulate', 'phoneNumber'],
  website: [],
};

export { ValidationError };

/**
 * Validate a PUT /channels/{name} body and return the fields to merge.
 * Throws ValidationError with a user-facing message.
 */
export function validateChannelUpdate(
  name: string,
  body: unknown,
): { enabled?: boolean; config: Record<string, unknown> } {
  if (!CHANNEL_NAMES.includes(name as ChannelName)) throw new ValidationError(`Unknown channel "${name}"`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (k !== 'enabled' && k !== 'config') throw new ValidationError(`Unknown field "${k}"`);
  }
  const out: { enabled?: boolean; config: Record<string, unknown> } = { config: {} };
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') throw new ValidationError('"enabled" must be a boolean');
    out.enabled = b.enabled;
  }
  if ('config' in b) {
    const c = b.config;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ValidationError('"config" must be an object');
    const allowed = EDITABLE_CONFIG[name as ChannelName];
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
      if (!allowed.includes(k)) {
        throw new ValidationError(
          name === 'email'
            ? 'Email addresses are deploy-time configuration and cannot be changed via the API'
            : `"${k}" is not an editable ${name} setting`,
        );
      }
      if (k === 'webhookUrl') {
        if (typeof v !== 'string' || !v.startsWith('https://hooks.slack.com/')) {
          throw new ValidationError('Slack webhook URL must start with https://hooks.slack.com/');
        }
      }
      if (k === 'simulate' && typeof v !== 'boolean') throw new ValidationError('"simulate" must be a boolean');
      if (k === 'phoneNumber' && (typeof v !== 'string' || (v !== '' && !/^\+[1-9]\d{7,14}$/.test(v)))) {
        throw new ValidationError('Phone number must be E.164 (e.g. +15551234567) or empty');
      }
      out.config[k] = v;
    }
  }
  if (out.enabled === undefined && Object.keys(out.config).length === 0) throw new ValidationError('Nothing to update');
  return out;
}

export function validateDedupWindow(body: unknown): number {
  const w = (body as { windowMinutes?: unknown } | null)?.windowMinutes;
  if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 1440) {
    throw new ValidationError('"windowMinutes" must be an integer from 1 to 1440');
  }
  return w;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------- History ----------

export interface ChannelResult {
  channel: string;
  status: string;
  [k: string]: unknown;
}

export function channelsToMap(results: unknown): Record<string, ChannelResult> {
  const map: Record<string, ChannelResult> = {};
  if (!Array.isArray(results)) return map;
  for (const r of results) {
    if (r && typeof r === 'object' && typeof (r as ChannelResult).channel === 'string') {
      const { channel, ...rest } = r as ChannelResult;
      map[channel] = { channel, ...rest } as ChannelResult;
    }
  }
  return map;
}

/**
 * A run only counts as SENT (and therefore for dedup) if at least one channel
 * actually delivered or simulated delivery; otherwise it is NOT_DELIVERED.
 */
export function finalStatus(requested: string, channels: Record<string, ChannelResult>): string {
  if (requested !== 'SENT') return requested;
  const delivered = Object.values(channels).some((c) => c.status === 'SENT' || c.status === 'SIMULATED');
  return delivered ? 'SENT' : 'NOT_DELIVERED';
}

/** CloudWatch Embedded Metric Format line: one Delivery count per channel. */
export function deliveryMetricLines(namespace: string, channels: Record<string, ChannelResult>, now: number): string[] {
  return Object.values(channels).map((c) =>
    JSON.stringify({
      _aws: {
        Timestamp: now,
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [['Channel', 'Status']], Metrics: [{ Name: 'Delivery', Unit: 'Count' }] }],
      },
      Channel: c.channel,
      Status: c.status,
      Delivery: 1,
    }),
  );
}
