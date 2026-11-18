/**
 * Synthesizes the stack and checks the spec's infrastructure acceptance criteria.
 * Run with `npm run test:infra` (slower: bundles every Lambda with esbuild).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NotificationStack } from '../lib/notification-stack';

const app = new App();
const stack = new NotificationStack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
Tags.of(app).add('Project', 'notification-demo'); // mirrors app/cdk-app.ts
const t = Template.fromStack(stack);
const json = t.toJSON();

function stateMachineDefinition(): string {
  const sm = Object.values<any>(json.Resources).find((r) => r.Type === 'AWS::StepFunctions::StateMachine');
  const parts: unknown[] = sm.Properties.DefinitionString['Fn::Join'][1];
  // Tokens (ARNs, names) are embedded inside JSON string values.
  return parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
}

test('1.2 no NAT gateways, no VPC endpoints, host SG has no ingress', () => {
  t.resourceCountIs('AWS::EC2::NatGateway', 0);
  t.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  const sgs = t.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupDescription: Match.stringLikeRegexp('Notification demo hosts') },
  });
  const [sg] = Object.values<any>(sgs);
  assert.equal(sg.Properties.SecurityGroupIngress, undefined);
});

test('1.3 Notifications table: keys, RecentIndex GSI, TTL, on-demand', () => {
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'sourceId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'RecentIndex' })],
  });
});

test('1.4 config seed includes the Slack placeholder', () => {
  assert.match(JSON.stringify(json), /hooks\.slack\.com\/services\/REPLACE_ME/);
});

test('1.5 queue has DLQ redrive after 5 receives and is subscribed to the topic', () => {
  t.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) });
  t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'sqs' });
});

test('2.x two hosts with no key pair; fleet log groups feed the rules engine (no per-host alarms)', () => {
  const instances = Object.values<any>(t.findResources('AWS::EC2::Instance'));
  assert.equal(instances.length, 2);
  for (const i of instances) assert.equal(i.Properties.KeyName, undefined);
  const types = instances.map((i) => i.Properties.InstanceType).sort();
  assert.deepEqual(types, ['t3.medium', 't3.small']);
  t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  t.resourceCountIs('AWS::Logs::MetricFilter', 0);
  for (const type of ['php-error', 'apache-access', 'windows-application', 'windows-system', 'windows-security']) {
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/notification-demo/logs/${type}` });
  }
  t.resourceCountIs('AWS::Logs::SubscriptionFilter', 5);
  t.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
    FilterPattern: '[ip, ident, user, timestamp, request, status_code >= 400, bytes, referer, agent]',
  });
});

test('rules engine: seeded default rules, can publish alerts, counters table has TTL', () => {
  const seed = JSON.stringify(t.findResources('Custom::AWS'));
  for (const id of ['php-fatal', 'cve-probe', 'web-login-failures', 'windows-logon-failures', 'windows-errors', 'any-error']) {
    assert.ok(seed.includes(id), `seed missing rule ${id}`);
  }
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'windowStart', KeyType: 'RANGE' },
    ],
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp('RulesEngine') } }));
  assert.match(policies, /sns:Publish/);
});

test('notifications carry log links: email body and Slack payload use them', () => {
  const def = stateMachineDefinition();
  assert.ok(def.includes('$.ai.internalBody'), 'email body should include log links');
  assert.ok(def.includes('"links.$":"$.links"'), 'Slack gets links');
});

test('3.2 workflow order: dedup before Bedrock, FAILED catch present', () => {
  const def = stateMachineDefinition();
  const idx = (s: string) => def.indexOf(`"${s}"`);
  for (const s of ['Check duplicate', 'Summarize with Bedrock', 'Guardrail check', 'Deliver to channels', 'Status failed']) {
    assert.ok(idx(s) >= 0, `missing state ${s}`);
  }
  const parsed = JSON.parse(def);
  assert.equal(parsed.StartAt, 'Process notification');
  const outer = parsed.States['Process notification'];
  assert.equal(outer.Type, 'Parallel');
  assert.equal(outer.Catch[0].Next, 'Status failed');
  assert.equal(outer.Branches[0].StartAt, 'Check duplicate');
  assert.equal(outer.Branches[0].States['Check duplicate'].Next, 'Duplicate?');
  assert.equal(outer.Branches[0].States['Duplicate?'].Default, 'Summarize with Bedrock');
});

test('4.1 Bedrock IAM covers inference profile and all routed regions', () => {
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  assert.match(policies, /inference-profile\/us\.anthropic\.claude-haiku-4-5-20251001-v1:0/);
  for (const r of ['us-east-1', 'us-east-2', 'us-west-2']) {
    assert.ok(policies.includes(`arn:aws:bedrock:${r}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`), r);
  }
});

test('project budget: tag-scoped, forecast-only alerts', () => {
  const [b] = Object.values<any>(t.findResources('AWS::Budgets::Budget'));
  assert.deepEqual(b.Properties.Budget.CostFilters, { TagKeyValue: ['user:Project$notification-demo'] });
  const types = b.Properties.NotificationsWithSubscribers.map((n: any) => n.Notification.NotificationType);
  assert.ok(types.length >= 1 && types.every((x: string) => x === 'FORECASTED'));
});

test('Bedrock calls go through the tagged application inference profile', () => {
  t.hasResourceProperties('AWS::Bedrock::ApplicationInferenceProfile', {
    Tags: Match.arrayWith([{ Key: 'Project', Value: 'notification-demo' }]),
  });
  t.hasResourceProperties('AWS::EC2::Instance', { PropagateTagsToVolumeOnCreation: true });
});

test('6.x HTTP API routes and outputs', () => {
  for (const key of [
    'GET /health',
    'GET /channels',
    'PUT /channels/{name}',
    'PUT /settings/dedup',
    'GET /history',
    'GET /rules',
    'PUT /rules/{id}',
    'DELETE /rules/{id}',
    'GET /logs/hosts',
    'POST /logs/query',
    'GET /logs/query/{id}',
  ]) {
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: key });
  }
  for (const o of ['ApiUrl', 'OperatorUiUrl', 'OperatorKeySecretName', 'DashboardUrl']) t.hasOutput(o, {});
});

test('all 11 application Lambdas run on Node 24 / arm64', () => {
  // Excludes CDK-managed helpers (BucketDeployment, custom-resource providers).
  const fns = Object.entries<any>(t.findResources('AWS::Lambda::Function')).filter(
    ([id]) => id.startsWith('Workflow') || id.startsWith('OperatorUi') || id.startsWith('LogAnalytics'),
  );
  assert.equal(fns.length, 11);
  for (const [, f] of fns) {
    assert.equal(f.Properties.Runtime, 'nodejs24.x');
    assert.deepEqual(f.Properties.Architectures, ['arm64']);
  }
});
