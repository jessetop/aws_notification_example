/** Posts the notice to the configured Slack incoming webhook, with links to the logs. */
import { isRealSlackWebhook } from './shared/logic';

interface Input {
  summary: string;
  alarmName: string;
  severity: string;
  config: { webhookUrl?: string };
  links?: { operatorUi?: string; console?: string };
}

function slackText(e: Input): string {
  const links = [
    e.links?.operatorUi ? `<${e.links.operatorUi}|View logs>` : '',
    e.links?.console ? `<${e.links.console}|CloudWatch Logs Insights>` : '',
  ].filter(Boolean);
  return `*[${e.severity}] ${e.alarmName}*\n${e.summary}${links.length ? `\n${links.join(' · ')}` : ''}`;
}

export const handler = async (event: Input) => {
  const url = event.config?.webhookUrl;
  if (!isRealSlackWebhook(url)) {
    return { channel: 'slack', status: 'SKIPPED_MISCONFIGURED', reason: 'Slack webhook URL is not set' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: slackText(event) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // Throwing lets Step Functions retry, then the branch Catch records FAILED.
    throw new Error(`Slack webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { channel: 'slack', status: 'SENT' };
};
