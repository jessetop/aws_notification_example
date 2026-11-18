/** Shared deploy-time configuration for the notification system demo. */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AlertRule } from '../lambda/shared/logs';
export const PROJECT = 'notification-demo';

export const AWS_PROFILE = 'roitraining';
export const REGION = 'us-east-1';

/**
 * Bedrock: Claude Haiku 4.5 via the US cross-region inference profile.
 * The profile routes to the regions below, and IAM must allow the foundation
 * model in every one of them.
 */
export const BEDROCK_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
export const BEDROCK_INFERENCE_PROFILE_ID = `us.${BEDROCK_MODEL_ID}`;
export const BEDROCK_ROUTED_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

/**
 * Personal settings live in the git-ignored `local.config.json` (see
 * `local.config.example.json`) or in environment variables, never in the repo.
 */
const local: { notifyEmail?: string; budgetAlertEmail?: string } = (() => {
  const file = join(__dirname, '..', 'local.config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
})();
export const PLACEHOLDER_EMAIL = 'notify@example.com';

/** SES sandbox: sender and recipient must both be verified identities. */
export const NOTIFY_EMAIL: string = process.env.NOTIFY_EMAIL ?? local.notifyEmail ?? PLACEHOLDER_EMAIL;

/** Project cost budget: forecast-based alerts only, scoped to the Project tag. */
export const BUDGET_MONTHLY_USD = 100;
export const BUDGET_FORECAST_ALERT_PERCENTS = [80, 100];
export const BUDGET_ALERT_EMAIL: string = process.env.BUDGET_ALERT_EMAIL ?? local.budgetAlertEmail ?? NOTIFY_EMAIL;

export const SLACK_PLACEHOLDER = 'https://hooks.slack.com/services/REPLACE_ME';
export const DEDUP_WINDOW_MINUTES = 15;

export const METRIC_NAMESPACE = 'App/Notifications';
export const DELIVERY_METRIC_NAMESPACE = 'App/Notifications/Delivery';

/** Fleet log groups: one per log type (`${LOG_GROUP_PREFIX}<type>`), one stream per host. */
export const LOG_GROUP_PREFIX = `/${PROJECT}/logs/`;
export { LOG_TYPES, type LogType } from '../lambda/shared/logs';

/**
 * Alert rules seeded on first deploy. After that they are edited in the operator
 * UI (Rules tab) and stored in the config table; the rules engine reloads them every 30s.
 */
export const DEFAULT_RULES: AlertRule[] = [
  {
    id: 'php-fatal',
    name: 'PHP fatal errors',
    enabled: true,
    logTypes: ['php-error'],
    terms: ['PHP Fatal error'],
    threshold: 3,
    windowMinutes: 5,
    severity: 'MEDIUM',
  },
  {
    id: 'cve-probe',
    name: 'Exploit / CVE probes',
    enabled: true,
    logTypes: ['apache-access'],
    terms: ['php-cgi', 'allow_url_include', 'wp-login.php', '/.env', '../', 'phpunit'],
    threshold: 3,
    windowMinutes: 5,
    severity: 'HIGH',
  },
  {
    id: 'web-login-failures',
    name: 'Failed web logins',
    enabled: true,
    logTypes: ['php-error'],
    terms: ['Failed login'],
    threshold: 5,
    windowMinutes: 5,
    severity: 'MEDIUM',
  },
  {
    id: 'windows-logon-failures',
    name: 'Windows failed logons (4625)',
    enabled: true,
    logTypes: ['windows-security'],
    eventIds: [4625],
    threshold: 5,
    windowMinutes: 5,
    severity: 'HIGH',
  },
  {
    id: 'windows-errors',
    name: 'Windows application/system errors',
    enabled: true,
    logTypes: ['windows-application', 'windows-system'],
    minLevel: 'ERROR',
    threshold: 3,
    windowMinutes: 5,
    severity: 'LOW',
  },
  {
    id: 'any-error',
    name: 'Any ERROR in any log (noisy)',
    enabled: false,
    logTypes: ['php-error', 'apache-access', 'windows-application', 'windows-system', 'windows-security'],
    minLevel: 'ERROR',
    threshold: 10,
    windowMinutes: 5,
    severity: 'MEDIUM',
  },
];

export const HOSTS = [
  { id: 'win-01', os: 'windows' as const },
  { id: 'ubuntu-01', os: 'ubuntu' as const },
];

export const CHANNELS = ['email', 'slack', 'sms', 'website'] as const;
