/**
 * Pure log-analytics logic: log types, line parsing, alert rules, Logs Insights
 * query building, and deep links. No AWS SDK imports, so it is unit-testable.
 */
import { ValidationError } from './errors';

// ---------- Log types ----------

/** One CloudWatch log group per log type; each server writes its own stream (stream name = host id). */
export const LOG_TYPES = ['php-error', 'apache-access', 'windows-application', 'windows-system', 'windows-security'] as const;
export type LogType = (typeof LOG_TYPES)[number];

export const isLogType = (v: unknown): v is LogType => typeof v === 'string' && (LOG_TYPES as readonly string[]).includes(v);

export function logGroupName(prefix: string, type: LogType): string {
  return `${prefix}${type}`;
}

export function logTypeFromGroup(groupName: string, prefix: string): LogType | undefined {
  if (!groupName.startsWith(prefix)) return undefined;
  const t = groupName.slice(prefix.length);
  return isLogType(t) ? t : undefined;
}

// ---------- Levels and parsing ----------

export const LEVELS = ['DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'CRITICAL'] as const;
export type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);

export interface ParsedLine {
  level: Level;
  eventId?: number;
  status?: number;
}

const WINDOWS_LEVEL_WORDS: Record<string, Level> = {
  CRITICAL: 'CRITICAL',
  ERROR: 'ERROR',
  WARNING: 'WARN',
  INFORMATION: 'INFO',
  VERBOSE: 'DEBUG',
};
const WINDOWS_LEVEL_NUMBERS: Record<string, Level> = { '0': 'INFO', '1': 'CRITICAL', '2': 'ERROR', '3': 'WARN', '4': 'INFO', '5': 'DEBUG' };

function keywordLevel(message: string): Level {
  if (/\b(critical|fatal|emerg(ency)?|alert)\b/i.test(message)) return 'CRITICAL';
  if (/\berror\b/i.test(message)) return 'ERROR';
  if (/\bwarn(ing)?\b/i.test(message)) return 'WARN';
  if (/\bnotice\b/i.test(message)) return 'NOTICE';
  if (/\bdebug\b/i.test(message)) return 'DEBUG';
  return 'INFO';
}

/** Normalize one raw log line of a given type into a level (+ Windows event ID / HTTP status). */
export function parseLine(type: LogType, message: string): ParsedLine {
  switch (type) {
    case 'apache-access': {
      // Combined format: ip ident user [time] "request" status bytes "referer" "agent"
      const m = message.match(/"\s(\d{3})\s/);
      const status = m ? Number(m[1]) : undefined;
      const level: Level = status === undefined ? 'INFO' : status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      return { level, status };
    }
    case 'php-error': {
      if (/PHP (Fatal error|Parse error|Recoverable fatal error)/i.test(message)) return { level: 'ERROR' };
      if (/PHP Warning/i.test(message)) return { level: 'WARN' };
      if (/PHP (Notice|Deprecated)/i.test(message)) return { level: 'NOTICE' };
      return { level: keywordLevel(message) };
    }
    default: {
      // CloudWatch agent text format: [Log] [LEVEL] [EventId] [Source] [Computer] message
      const text = message.match(/^\s*\[[^\]]*\]\s*\[([^\]]*)\]\s*\[(\d+)\]/);
      if (text) {
        return { level: WINDOWS_LEVEL_WORDS[text[1].trim().toUpperCase()] ?? keywordLevel(text[1]), eventId: Number(text[2]) };
      }
      // XML format fallback.
      const id = message.match(/<EventID[^>]*>(\d+)</);
      const lvl = message.match(/<Level>(\d)<\/Level>/);
      if (id || lvl) {
        return { level: (lvl && WINDOWS_LEVEL_NUMBERS[lvl[1]]) || 'INFO', eventId: id ? Number(id[1]) : undefined };
      }
      return { level: keywordLevel(message) };
    }
  }
}

// ---------- Alert rules ----------

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH'];

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  logTypes: LogType[];
  /** Match lines at or above this level. */
  minLevel?: Level;
  /** Match lines containing any of these (case-insensitive). */
  terms?: string[];
  /** Match Windows events with one of these IDs. */
  eventIds?: number[];
  /** Alert when a single host has at least this many matches inside one window. */
  threshold: number;
  windowMinutes: number;
  severity: Severity;
}

export function ruleMatches(rule: AlertRule, type: LogType, parsed: ParsedLine, message: string): boolean {
  if (!rule.enabled || !rule.logTypes.includes(type)) return false;
  if (rule.minLevel && rank(parsed.level) < rank(rule.minLevel)) return false;
  if (rule.terms?.length) {
    const lower = message.toLowerCase();
    if (!rule.terms.some((t) => lower.includes(t.toLowerCase()))) return false;
  }
  if (rule.eventIds?.length && (parsed.eventId === undefined || !rule.eventIds.includes(parsed.eventId))) return false;
  return true;
}

export const RULE_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** Validate a PUT /rules/{id} body. Throws ValidationError with a user-facing message. */
export function validateRule(id: string, body: unknown): AlertRule {
  if (!RULE_ID_RE.test(id)) throw new ValidationError('Rule ID must be 2-48 chars: lowercase letters, digits, hyphens');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const allowed = ['name', 'enabled', 'logTypes', 'minLevel', 'terms', 'eventIds', 'threshold', 'windowMinutes', 'severity'];
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw new ValidationError(`Unknown field "${k}"`);

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 2 || name.length > 80) throw new ValidationError('"name" must be 2-80 characters');
  if (typeof b.enabled !== 'boolean') throw new ValidationError('"enabled" must be a boolean');
  if (!Array.isArray(b.logTypes) || b.logTypes.length === 0 || !b.logTypes.every(isLogType)) {
    throw new ValidationError(`"logTypes" must be a non-empty list of: ${LOG_TYPES.join(', ')}`);
  }
  const rule: AlertRule = {
    id,
    name,
    enabled: b.enabled,
    logTypes: [...new Set(b.logTypes as LogType[])],
    threshold: intIn(b.threshold, 'threshold', 1, 10_000),
    windowMinutes: intIn(b.windowMinutes, 'windowMinutes', 1, 60),
    severity: SEVERITIES.includes(b.severity as Severity)
      ? (b.severity as Severity)
      : fail(`"severity" must be one of ${SEVERITIES.join(', ')}`),
  };
  if (b.minLevel !== undefined && b.minLevel !== null && b.minLevel !== '') {
    if (!(LEVELS as readonly unknown[]).includes(b.minLevel)) throw new ValidationError(`"minLevel" must be one of ${LEVELS.join(', ')}`);
    rule.minLevel = b.minLevel as Level;
  }
  if (b.terms !== undefined) {
    if (!Array.isArray(b.terms) || b.terms.length > 20 || !b.terms.every((t) => typeof t === 'string')) {
      throw new ValidationError('"terms" must be a list of up to 20 strings');
    }
    const terms = (b.terms as string[]).map((t) => t.trim()).filter(Boolean);
    if (terms.some((t) => t.length > 100)) throw new ValidationError('Each term must be at most 100 characters');
    if (terms.length) rule.terms = terms;
  }
  if (b.eventIds !== undefined) {
    if (!Array.isArray(b.eventIds) || b.eventIds.length > 20 || !b.eventIds.every((n) => Number.isInteger(n) && n >= 0 && n <= 65535)) {
      throw new ValidationError('"eventIds" must be a list of up to 20 integers (0-65535)');
    }
    if (b.eventIds.length) rule.eventIds = [...new Set(b.eventIds as number[])];
  }
  if (!rule.minLevel && !rule.terms && !rule.eventIds) {
    throw new ValidationError('A rule needs at least one condition: minimum level, terms, or event IDs');
  }
  return rule;
}

function intIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`"${field}" must be an integer from ${min} to ${max}`);
  }
  return v;
}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

/** Start of the fixed counting window that contains `ts`. */
export function windowBucket(ts: number, windowMinutes: number): number {
  const size = windowMinutes * 60_000;
  return Math.floor(ts / size) * size;
}

/** True exactly once per window: when this batch takes the count from below to at/above threshold. */
export function crossedThreshold(previous: number, next: number, threshold: number): boolean {
  return previous < threshold && next >= threshold;
}

// ---------- Rule alert message (rules engine → SNS → SQS → workflow) ----------

export const RULE_ALERT_SOURCE = 'notification-demo.rules';

export interface RuleAlert {
  source: typeof RULE_ALERT_SOURCE;
  ruleId: string;
  ruleName: string;
  host: string;
  severity: Severity;
  count: number;
  threshold: number;
  windowMinutes: number;
  windowStart: string;
  detectedAt: string;
  logTypes: LogType[];
  terms: string[];
  eventIds: number[];
  minLevel?: Level;
  samples: string[];
}

// ---------- Log query scope, Logs Insights query, links ----------

export interface LogScope {
  hosts: string[];
  logTypes: LogType[];
  terms: string[];
  problemsOnly: boolean;
  from: string; // ISO
  to: string; // ISO
}

const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_RANGE_MS = 7 * 86_400_000;

/** Validate a POST /logs/query body into a scope (+ optional raw query and limit). */
export function validateLogQuery(body: unknown, now: number): { scope: LogScope; limit: number; query?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  const hosts = b.hosts ?? [];
  if (!Array.isArray(hosts) || hosts.length > 200 || !hosts.every((h) => typeof h === 'string' && HOST_RE.test(h))) {
    throw new ValidationError('"hosts" must be a list of host IDs');
  }
  const logTypes = b.logTypes ?? [...LOG_TYPES];
  if (!Array.isArray(logTypes) || logTypes.length === 0 || !logTypes.every(isLogType)) {
    throw new ValidationError(`"logTypes" must be a non-empty list of: ${LOG_TYPES.join(', ')}`);
  }
  const terms = b.terms ?? [];
  if (!Array.isArray(terms) || terms.length > 10 || !terms.every((t) => typeof t === 'string' && t.length <= 100)) {
    throw new ValidationError('"terms" must be a list of up to 10 strings (max 100 chars)');
  }
  const to = b.to === undefined ? now : Date.parse(String(b.to));
  const from = b.from === undefined ? to - 3_600_000 : Date.parse(String(b.from));
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ValidationError('"from"/"to" must be ISO timestamps');
  if (from >= to) throw new ValidationError('"from" must be before "to"');
  if (to - from > MAX_RANGE_MS) throw new ValidationError('Time range can be at most 7 days');
  const limit = b.limit === undefined ? 200 : b.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ValidationError('"limit" must be an integer from 1 to 1000');
  }
  let query: string | undefined;
  if (b.query !== undefined && b.query !== '') {
    if (typeof b.query !== 'string' || b.query.length > 4000) throw new ValidationError('"query" must be a string of at most 4000 characters');
    query = b.query;
  }
  return {
    scope: {
      hosts: [...new Set(hosts as string[])],
      logTypes: [...new Set(logTypes as LogType[])],
      terms: (terms as string[]).map((t) => t.trim()).filter(Boolean),
      problemsOnly: b.problemsOnly === true,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    },
    limit,
    query,
  };
}

/** Lines that look like problems across all log formats (errors, warnings, failures, HTTP 4xx/5xx). */
export const PROBLEM_REGEX = String.raw`(?i)(\b(fatal|error|critical|warn|warning|fail|failed|failure|denied)\b|\[(ERROR|WARNING|CRITICAL)\]|" [45]\d\d )`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Build a CloudWatch Logs Insights query for a scope. Log groups are passed separately. */
export function buildInsightsQuery(scope: Pick<LogScope, 'hosts' | 'terms' | 'problemsOnly'>, limit = 200): string {
  const lines = ['fields @timestamp, @log, @logStream, @message'];
  if (scope.hosts.length) lines.push(`| filter @logStream in [${scope.hosts.map((h) => JSON.stringify(h)).join(', ')}]`);
  if (scope.terms.length) lines.push(`| filter @message like /(?i)(${scope.terms.map(escapeRegex).join('|')})/`);
  if (scope.problemsOnly) lines.push(`| filter @message like /${PROBLEM_REGEX}/`);
  lines.push('| sort @timestamp desc', `| limit ${limit}`);
  return lines.join('\n');
}

/** Scope for a rule alert: the alerting host and rule's logs, from shortly before the window to shortly after detection. */
export function scopeForAlert(a: Pick<RuleAlert, 'host' | 'logTypes' | 'terms' | 'eventIds' | 'minLevel' | 'windowStart' | 'detectedAt'>): LogScope {
  const from = Date.parse(a.windowStart) - 5 * 60_000;
  const to = Date.parse(a.detectedAt) + 5 * 60_000;
  const terms = a.terms.length ? a.terms : a.eventIds.map((id) => `[${id}]`);
  return {
    hosts: [a.host],
    logTypes: a.logTypes,
    terms,
    problemsOnly: !terms.length && Boolean(a.minLevel),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/** Deep link into the operator UI's Logs tab with the scope prefilled. */
export function operatorUiLogsUrl(uiBaseUrl: string, scope: LogScope): string {
  const p = new URLSearchParams();
  for (const h of scope.hosts) p.append('host', h);
  for (const t of scope.logTypes) p.append('type', t);
  for (const t of scope.terms) p.append('term', t);
  if (scope.problemsOnly) p.set('problems', '1');
  p.set('from', scope.from);
  p.set('to', scope.to);
  return `${uiBaseUrl.replace(/\/$/, '')}/index.html#logs?${p.toString()}`;
}

/** Percent-encode a value for the console's URL state, with '*' in place of '%' (structural ~ ( ) ' included). */
function consoleValue(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
    .replace(/%([0-9A-F]{2})/gi, (_, h: string) => `*${h.toLowerCase()}`);
}

/**
 * Deep link into the CloudWatch Logs Insights console. The console keeps its state in
 * the fragment as `?queryDetail=~(key~'value~...)`, with `?`/`=` written as `$3F`/`$3D`
 * and each value percent-encoded using '*' instead of '%'.
 */
export function consoleInsightsUrl(region: string, logGroups: string[], query: string, from: string, to: string): string {
  const v = consoleValue;
  const detail =
    `~(end~'${v(to)}~start~'${v(from)}~timeType~'ABSOLUTE~tz~'UTC~editorString~'${v(query)}` +
    `~source~(${logGroups.map((g) => `~'${v(g)}`).join('')}))`;
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:logs-insights$3FqueryDetail$3D${detail}`;
}

export interface LogLinks {
  operatorUi: string;
  console: string;
}

export function buildLogLinks(scope: LogScope, opts: { uiBaseUrl: string; region: string; groupPrefix: string }): LogLinks {
  return {
    operatorUi: operatorUiLogsUrl(opts.uiBaseUrl, scope),
    console: consoleInsightsUrl(
      opts.region,
      scope.logTypes.map((t) => logGroupName(opts.groupPrefix, t)),
      buildInsightsQuery(scope),
      scope.from,
      scope.to,
    ),
  };
}

/** Plain-text body for internal channels (email): the notice plus links to the logs. */
export function withLogLinks(summary: string, links?: Partial<LogLinks>): string {
  if (!links?.operatorUi && !links?.console) return summary;
  const parts = [summary, ''];
  if (links.operatorUi) parts.push(`View the logs: ${links.operatorUi}`);
  if (links.console) parts.push(`CloudWatch Logs Insights: ${links.console}`);
  return parts.join('\n');
}
