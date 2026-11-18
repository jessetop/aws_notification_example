#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { NOTIFY_EMAIL, PLACEHOLDER_EMAIL, PROJECT, REGION } from '../lib/config';
import { NotificationStack } from '../lib/notification-stack';

if (NOTIFY_EMAIL === PLACEHOLDER_EMAIL && process.env.ALLOW_PLACEHOLDER_EMAIL !== '1') {
  throw new Error(
    'Set your notification address first: copy local.config.example.json to local.config.json ' +
      'and fill in notifyEmail (or set the NOTIFY_EMAIL environment variable).',
  );
}

const app = new App();
new NotificationStack(app, 'NotificationDemoStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: 'Municipality-style multi-channel notification system demo',
});
Tags.of(app).add('Project', PROJECT);
