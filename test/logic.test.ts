import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelsToMap,
  dedupHash,
  deliveryMetricLines,
  finalStatus,
  isRealSlackWebhook,
  parseAlarmRecord,
  parseGuardrailReply,
  ruleCheck,
  safeEqual,
  templatedSummary,
  truncateSms,
  validateChannelUpdate,
  validateDedupWindow,
  ValidationError,
  windowStart,
} from '../lambda/shared/logic';

const alarm = {
  AlarmName: 'notif-win-01-CveHits',
  NewStateValue: 'ALARM',
  NewStateReason: 'Threshold Crossed: 1 datapoint [6.0] was >= 3.0',
  StateChangeTime: '2026-11-17T20:00:00.000+0000',
  Trigger: {
    MetricName: 'CveHits',
    Namespace: 'App/Notifications',
    Dimensions: [{ name: 'host', value: 'win-01' }],
  },
};
const sqsBody = JSON.stringify({ Type: 'Notification', MessageId: 'abc', Message: JSON.stringify(alarm) });

test('parseAlarmRecord unwraps SNS → CloudWatch alarm', () => {
  const e = parseAlarmRecord(sqsBody, 1000);
  assert.equal(e.alarmName, 'notif-win-01-CveHits');
  assert.equal(e.sourceId, 'host:win-01');
  assert.equal(e.eventType, 'CveHits');
  assert.equal(e.severity, 'HIGH');
  assert.equal(e.trigger.dimensions.host, 'win-01');
  assert.equal(e.receivedAt, 1000);
  assert.equal(JSON.parse(e.rawEvent).AlarmName, alarm.AlarmName);
});

test('parseAlarmRecord maps severities and rejects junk', () => {
  const auth = { ...alarm, Trigger: { ...alarm.Trigger, MetricName: 'AuthFail' } };
  assert.equal(parseAlarmRecord(JSON.stringify({ Message: JSON.stringify(auth) }), 0).severity, 'MEDIUM');
  assert.throws(() => parseAlarmRecord('not json', 0));
  assert.throws(() => parseAlarmRecord(JSON.stringify({ Message: '{"hello":1}' }), 0));
});

test('dedupHash is stable, 16 hex, and input-sensitive', () => {
  const a = dedupHash('host:win-01', 'CveHits', 'HIGH');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, dedupHash('host:win-01', 'CveHits', 'HIGH'));
  assert.notEqual(a, dedupHash('host:win-01', 'AuthFail', 'HIGH'));
});

test('windowStart subtracts minutes', () => {
  assert.equal(windowStart(1_000_000, 15), 1_000_000 - 900_000);
});

test('templatedSummary mentions host and severity', () => {
  const s = templatedSummary({ eventType: 'CveHits', severity: 'HIGH', sourceId: 'host:win-01', stateChangeTime: 't' });
  assert.match(s, /HIGH/);
  assert.match(s, /win-01/);
  assert.equal(ruleCheck(s).appropriate, true);
});

test('ruleCheck flags secrets, PII, profanity; allows normal text and timestamps', () => {
  assert.equal(ruleCheck('Server win-01 saw failed logins at 1731867600000 today.').appropriate, true);
  assert.equal(ruleCheck('key AKIAABCDEFGHIJKLMNOP leaked').appropriate, false);
  assert.equal(ruleCheck('the password=hunter2 was used').appropriate, false);
  assert.equal(ruleCheck('Resident SSN 123-45-6789 exposed').appropriate, false);
  assert.equal(ruleCheck('Card 4111 1111 1111 1111 was charged').appropriate, false);
  assert.equal(ruleCheck('this is shit').appropriate, false);
  assert.equal(ruleCheck('   ').appropriate, false);
});

test('parseGuardrailReply extracts JSON from model text', () => {
  assert.deepEqual(parseGuardrailReply('Sure: {"appropriate": false, "reason": "vague"}'), { appropriate: false, reason: 'vague' });
  assert.equal(parseGuardrailReply('no json here'), null);
  assert.equal(parseGuardrailReply('{"appropriate": "yes"}'), null);
});

test('isRealSlackWebhook rejects placeholder and other hosts', () => {
  assert.equal(isRealSlackWebhook('https://hooks.slack.com/services/T0/B0/xyz'), true);
  assert.equal(isRealSlackWebhook('https://hooks.slack.com/services/REPLACE_ME'), false);
  assert.equal(isRealSlackWebhook('https://evil.example.com/hook'), false);
  assert.equal(isRealSlackWebhook(undefined), false);
});

test('truncateSms caps length', () => {
  assert.equal(truncateSms('x'.repeat(500)).length, 300);
  assert.equal(truncateSms('short'), 'short');
});

test('validateChannelUpdate accepts allowed edits', () => {
  assert.deepEqual(validateChannelUpdate('slack', { config: { webhookUrl: 'https://hooks.slack.com/services/a' } }), {
    config: { webhookUrl: 'https://hooks.slack.com/services/a' },
  });
  assert.deepEqual(validateChannelUpdate('email', { enabled: false }), { enabled: false, config: {} });
  assert.deepEqual(validateChannelUpdate('sms', { config: { phoneNumber: '+15551234567', simulate: false } }), {
    config: { phoneNumber: '+15551234567', simulate: false },
  });
  assert.deepEqual(validateChannelUpdate('sms', { config: { phoneNumber: '' } }), { config: { phoneNumber: '' } });
});

test('validateChannelUpdate rejects unsafe or malformed edits', () => {
  const bad: Array<[string, unknown]> = [
    ['slack', { config: { webhookUrl: 'https://attacker.example/hook' } }],
    ['email', { config: { toAddresses: ['x@example.com'] } }],
    ['email', { config: { fromAddress: 'x@example.com' } }],
    ['sms', { config: { phoneNumber: '5551234' } }],
    ['sms', { config: { simulate: 'no' } }],
    ['website', { config: { bucket: 'other' } }],
    ['fax', { enabled: true }],
    ['slack', { enabled: 'true' }],
    ['slack', { extra: 1 }],
    ['slack', {}],
    ['slack', null],
  ];
  for (const [name, body] of bad) assert.throws(() => validateChannelUpdate(name, body), ValidationError, `${name} ${JSON.stringify(body)}`);
});

test('validateDedupWindow bounds', () => {
  assert.equal(validateDedupWindow({ windowMinutes: 30 }), 30);
  for (const w of [0, 1441, 2.5, '15', undefined]) assert.throws(() => validateDedupWindow({ windowMinutes: w }), ValidationError);
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('finalStatus downgrades SENT when nothing was delivered', () => {
  const none = channelsToMap([{ channel: 'email', status: 'DISABLED' }, { channel: 'slack', status: 'FAILED' }]);
  const some = channelsToMap([{ channel: 'email', status: 'FAILED' }, { channel: 'sms', status: 'SIMULATED' }]);
  assert.equal(finalStatus('SENT', none), 'NOT_DELIVERED');
  assert.equal(finalStatus('SENT', some), 'SENT');
  assert.equal(finalStatus('SKIPPED_DUPLICATE', {}), 'SKIPPED_DUPLICATE');
  assert.equal(finalStatus('FAILED', {}), 'FAILED');
});

test('channelsToMap and deliveryMetricLines', () => {
  const map = channelsToMap([
    { channel: 'email', status: 'SENT', messageId: 'm1' },
    { channel: 'sms', status: 'SIMULATED' },
    'garbage',
  ]);
  assert.deepEqual(Object.keys(map), ['email', 'sms']);
  assert.deepEqual(channelsToMap(undefined), {});
  const lines = deliveryMetricLines('NS', map, 5).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]._aws.CloudWatchMetrics[0].Namespace, 'NS');
  assert.equal(lines[1].Status, 'SIMULATED');
  assert.equal(lines[1].Delivery, 1);
});
