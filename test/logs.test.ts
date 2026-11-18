import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlarmRecord, ValidationError } from '../lambda/shared/logic';
import {
  buildInsightsQuery,
  buildLogLinks,
  consoleInsightsUrl,
  crossedThreshold,
  logTypeFromGroup,
  parseLine,
  RULE_ALERT_SOURCE,
  ruleMatches,
  scopeForAlert,
  validateLogQuery,
  validateRule,
  windowBucket,
  withLogLinks,
  type AlertRule,
} from '../lambda/shared/logs';
import { DEFAULT_RULES } from '../lib/config';

const ACCESS_404 = '127.0.0.1 - - [17/Nov/2026:20:00:01 +0000] "GET /wp-login.php HTTP/1.1" 404 435 "-" "zgrab/0.x"';
const ACCESS_200 = '127.0.0.1 - - [17/Nov/2026:20:00:02 +0000] "GET / HTTP/1.1" 200 312 "-" "curl/8.5.0"';
const ACCESS_500 = '127.0.0.1 - - [17/Nov/2026:20:00:04 +0000] "GET /permits.php?id=abc HTTP/1.1" 500 185 "-" "curl/8.5.0"';
const PHP_FATAL =
  "[17-Nov-2026 20:00:04 UTC] PHP Fatal error:  Uncaught TypeError: PermitService::find(): Argument #1 ($id) must be of type int, string given in /var/www/html/permits.php:11\nStack trace:\n#0 {main}";
const PHP_WARNING = '[17-Nov-2026 20:00:05 UTC] PHP Warning:  Undefined array key 3 in /var/www/html/report.php on line 7';
const PHP_AUTH = '[17-Nov-2026 20:00:06 UTC] WARN [auth] Failed login for user "admin" from 203.0.113.9';
const WIN_4625 = '[Security] [INFORMATION] [4625] [Microsoft-Windows-Security-Auditing] [EC2AMAZ-1] [An account failed to log on.]';
const WIN_APP_ERR = '[Application] [ERROR] [1001] [PermitsPortal] [EC2AMAZ-1] [PermitService: database connection failed]';
const WIN_SYS_WARN = '[System] [WARNING] [2001] [PermitsSync] [EC2AMAZ-1] [Permit sync job exceeded its 30s timeout]';

const rule = (id: string) => DEFAULT_RULES.find((r) => r.id === id)!;

test('parseLine normalizes levels across formats', () => {
  assert.deepEqual(parseLine('apache-access', ACCESS_404), { level: 'WARN', status: 404 });
  assert.deepEqual(parseLine('apache-access', ACCESS_200), { level: 'INFO', status: 200 });
  assert.deepEqual(parseLine('apache-access', ACCESS_500), { level: 'ERROR', status: 500 });
  assert.equal(parseLine('php-error', PHP_FATAL).level, 'ERROR');
  assert.equal(parseLine('php-error', PHP_WARNING).level, 'WARN');
  assert.equal(parseLine('php-error', PHP_AUTH).level, 'WARN');
  assert.deepEqual(parseLine('windows-security', WIN_4625), { level: 'INFO', eventId: 4625 });
  assert.deepEqual(parseLine('windows-application', WIN_APP_ERR), { level: 'ERROR', eventId: 1001 });
  assert.deepEqual(parseLine('windows-system', WIN_SYS_WARN), { level: 'WARN', eventId: 2001 });
  // XML event format fallback
  assert.deepEqual(parseLine('windows-security', '<Event><System><EventID>4625</EventID><Level>0</Level></System></Event>'), {
    level: 'INFO',
    eventId: 4625,
  });
});

test('default rules match the lines they are meant for, and not others', () => {
  const m = (id: string, type: Parameters<typeof parseLine>[0], line: string) => ruleMatches(rule(id), type, parseLine(type, line), line);
  assert.ok(m('php-fatal', 'php-error', PHP_FATAL));
  assert.ok(!m('php-fatal', 'php-error', PHP_WARNING));
  assert.ok(m('cve-probe', 'apache-access', ACCESS_404));
  assert.ok(!m('cve-probe', 'apache-access', ACCESS_500));
  assert.ok(m('web-login-failures', 'php-error', PHP_AUTH));
  assert.ok(m('windows-logon-failures', 'windows-security', WIN_4625));
  assert.ok(!m('windows-logon-failures', 'windows-application', WIN_APP_ERR));
  assert.ok(m('windows-errors', 'windows-application', WIN_APP_ERR));
  assert.ok(!m('windows-errors', 'windows-system', WIN_SYS_WARN), 'warnings are below the ERROR threshold');
  assert.ok(!m('any-error', 'php-error', PHP_FATAL), 'disabled rules never match');
  assert.ok(ruleMatches({ ...rule('any-error'), enabled: true }, 'apache-access', parseLine('apache-access', ACCESS_500), ACCESS_500));
});

test('every default rule passes API validation', () => {
  for (const { id, ...body } of DEFAULT_RULES) assert.deepEqual(validateRule(id, body), { id, ...body });
});

test('validateRule rejects bad input', () => {
  const ok = { name: 'Test', enabled: true, logTypes: ['php-error'], minLevel: 'ERROR', threshold: 3, windowMinutes: 5, severity: 'LOW' };
  assert.ok(validateRule('test-rule', ok));
  const bad: Array<[string, unknown]> = [
    ['Bad ID!', ok],
    ['x', ok],
    ['test', { ...ok, logTypes: ['syslog'] }],
    ['test', { ...ok, logTypes: [] }],
    ['test', { ...ok, threshold: 0 }],
    ['test', { ...ok, windowMinutes: 61 }],
    ['test', { ...ok, severity: 'URGENT' }],
    ['test', { ...ok, minLevel: 'LOUD' }],
    ['test', { ...ok, minLevel: undefined }], // no condition at all
    ['test', { ...ok, eventIds: [70000] }],
    ['test', { ...ok, extra: 1 }],
    ['test', [] as unknown],
  ];
  for (const [id, body] of bad) assert.throws(() => validateRule(id, body), ValidationError, JSON.stringify([id, body]));
});

test('windowBucket and crossedThreshold fire once per window', () => {
  const t = Date.parse('2026-11-17T20:03:30Z');
  assert.equal(new Date(windowBucket(t, 5)).toISOString(), '2026-11-17T20:00:00.000Z');
  assert.ok(crossedThreshold(0, 3, 3));
  assert.ok(crossedThreshold(2, 7, 3));
  assert.ok(!crossedThreshold(3, 4, 3), 'already alerted this window');
  assert.ok(!crossedThreshold(0, 2, 3));
});

test('logTypeFromGroup', () => {
  assert.equal(logTypeFromGroup('/notification-demo/logs/php-error', '/notification-demo/logs/'), 'php-error');
  assert.equal(logTypeFromGroup('/notification-demo/logs/other', '/notification-demo/logs/'), undefined);
  assert.equal(logTypeFromGroup('/aws/lambda/x', '/notification-demo/logs/'), undefined);
});

test('buildInsightsQuery escapes terms and scopes hosts', () => {
  const q = buildInsightsQuery({ hosts: ['ubuntu-01', 'win-01'], terms: ['../', 'a|b'], problemsOnly: true }, 50);
  assert.match(q, /^fields @timestamp, @log, @logStream, @message/);
  assert.ok(q.includes('| filter @logStream in ["ubuntu-01", "win-01"]'));
  assert.ok(q.includes('| filter @message like /(?i)(\\.\\.\\/|a\\|b)/'), q);
  assert.ok(q.includes('| limit 50'));
  assert.equal(buildInsightsQuery({ hosts: [], terms: [], problemsOnly: false }).split('\n').length, 3);
});

test('validateLogQuery defaults and bounds', () => {
  const now = Date.parse('2026-11-17T20:00:00Z');
  const { scope, limit } = validateLogQuery({}, now);
  assert.equal(scope.to, '2026-11-17T20:00:00.000Z');
  assert.equal(scope.from, '2026-11-17T19:00:00.000Z');
  assert.equal(scope.logTypes.length, 5);
  assert.equal(limit, 200);
  assert.throws(() => validateLogQuery({ hosts: ['bad host'] }, now), ValidationError);
  assert.throws(() => validateLogQuery({ logTypes: ['nope'] }, now), ValidationError);
  assert.throws(() => validateLogQuery({ from: '2026-11-01T00:00:00Z', to: '2026-11-17T00:00:00Z' }, now), /7 days/);
  assert.throws(() => validateLogQuery({ from: '2026-11-17T20:00:00Z', to: '2026-11-17T19:00:00Z' }, now), ValidationError);
  assert.throws(() => validateLogQuery({ limit: 5000 }, now), ValidationError);
});

const alertMsg = {
  source: RULE_ALERT_SOURCE,
  ruleId: 'cve-probe',
  ruleName: 'Exploit / CVE probes',
  host: 'ubuntu-01',
  severity: 'HIGH',
  count: 4,
  threshold: 3,
  windowMinutes: 5,
  windowStart: '2026-11-17T20:00:00.000Z',
  detectedAt: '2026-11-17T20:02:00.000Z',
  logTypes: ['apache-access'],
  terms: ['php-cgi', 'wp-login.php'],
  eventIds: [],
  samples: [ACCESS_404],
};

test('parseAlarmRecord accepts rules-engine alerts', () => {
  const body = JSON.stringify({ Type: 'Notification', Message: JSON.stringify(alertMsg) });
  const input = parseAlarmRecord(body, Date.parse('2026-11-17T20:02:05Z'));
  assert.equal(input.alarmName, 'Exploit / CVE probes');
  assert.equal(input.eventType, 'cve-probe');
  assert.equal(input.sourceId, 'host:ubuntu-01');
  assert.equal(input.severity, 'HIGH');
  assert.equal(input.reason, '4 matching log lines within 5 min (threshold 3)');
  assert.deepEqual(input.logs, {
    hosts: ['ubuntu-01'],
    logTypes: ['apache-access'],
    terms: ['php-cgi', 'wp-login.php'],
    problemsOnly: false,
    from: '2026-11-17T19:55:00.000Z',
    to: '2026-11-17T20:07:00.000Z',
  });
  assert.equal(input.samples?.length, 1);
});

test('scopeForAlert uses event IDs as terms, or problemsOnly for level rules', () => {
  const base = { host: 'win-01', logTypes: ['windows-security' as const], windowStart: alertMsg.windowStart, detectedAt: alertMsg.detectedAt };
  assert.deepEqual(scopeForAlert({ ...base, terms: [], eventIds: [4625] }).terms, ['[4625]']);
  const lvl = scopeForAlert({ ...base, terms: [], eventIds: [], minLevel: 'ERROR' });
  assert.deepEqual([lvl.terms, lvl.problemsOnly], [[], true]);
});

test('log links: operator UI hash and CloudWatch console URL', () => {
  const scope = scopeForAlert({ ...alertMsg, logTypes: ['apache-access'], minLevel: undefined } as never);
  const links = buildLogLinks(scope, { uiBaseUrl: 'http://site.example/', region: 'us-east-1', groupPrefix: '/notification-demo/logs/' });
  const ui = new URL(links.operatorUi);
  assert.equal(ui.pathname, '/index.html');
  const params = new URLSearchParams(ui.hash.replace(/^#logs\?/, ''));
  assert.deepEqual(params.getAll('host'), ['ubuntu-01']);
  assert.deepEqual(params.getAll('term'), ['php-cgi', 'wp-login.php']);
  assert.equal(params.get('from'), '2026-11-17T19:55:00.000Z');

  assert.ok(links.console.startsWith('https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:logs-insights$3FqueryDetail$3D~(end~'));
  assert.ok(!links.console.includes('%'), 'console URL never uses raw percent-encoding');
  assert.ok(links.console.endsWith("~source~(~'*2fnotification-demo*2flogs*2fapache-access))"), links.console);
  assert.ok(links.console.includes("~start~'2026-11-17T19*3a55*3a00.000Z~"), links.console);
});

test('consoleInsightsUrl round-trips its query', () => {
  const url = consoleInsightsUrl('us-east-1', ['/g'], 'fields @message\n| limit 5', '2026-11-17T19:00:00.000Z', '2026-11-17T20:00:00.000Z');
  const editor = url.match(/editorString~'([^~]*)/)![1];
  assert.ok(!/[()'~]/.test(editor), 'structural characters are encoded inside values');
  assert.equal(decodeURIComponent(editor.replace(/\*/g, '%')), 'fields @message\n| limit 5');
});

test('withLogLinks', () => {
  assert.equal(withLogLinks('Hello', undefined), 'Hello');
  assert.equal(withLogLinks('Hello', { operatorUi: 'http://a', console: 'https://b' }), 'Hello\n\nView the logs: http://a\nCloudWatch Logs Insights: https://b');
});

// Type check: DEFAULT_RULES really are AlertRules.
const _rules: AlertRule[] = DEFAULT_RULES;
void _rules;
