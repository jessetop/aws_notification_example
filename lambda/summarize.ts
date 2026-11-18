/** Summarize an alert as a short public notice, with a templated fallback. */
import { converse } from './shared/bedrock';
import { templatedSummary, type WorkflowInput } from './shared/logic';
import { withLogLinks } from './shared/logs';

const SYSTEM = `You write short public service notices for a city government's IT department.
Given a monitoring alert as JSON, write 2-3 plain-language sentences for residents and staff:
what happened, which server, how serious it is, and what (if anything) people should do.
"rule" is the name of the monitoring rule that fired, "reason" says how many matching log lines were seen and over what window,
and "sampleLogLines" are a few of the log lines that matched. Never quote log lines.
Stick strictly to what the rule, reason, and sample lines show:
- Describe the kind of problem the sample lines actually show (e.g. application errors, request timeouts, failed sign-ins). If they show more than one kind, mention each briefly; do not merge them into a single invented cause.
- Do not invent causes, durations, or impact that the lines do not show.
- Never say the problem is resolved, temporary, or over. The alert only means it was detected; say IT staff are looking into it.
- Do not tell people that no action is needed. If there is nothing for residents to do, say IT is investigating and further notice will follow if services are affected.
The "host" field is the name of a city server (not a desktop or workstation); refer to it as "server <host>".
Do not include raw JSON, IP addresses, usernames, file paths, credentials, account numbers, or speculation about attackers.
The text is sent as plain-text email and SMS: no markdown, no bold/asterisks, no headings, no bullet points.
Reply with the notice text only.`;

export const handler = async (event: WorkflowInput) => {
  let summary: string;
  let fallback = false;
  let fallbackReason: string | undefined;
  try {
    summary = await converse(
      SYSTEM,
      JSON.stringify({
        rule: event.alarmName,
        eventType: event.eventType,
        severity: event.severity,
        host: event.trigger?.dimensions?.host,
        time: event.stateChangeTime,
        reason: event.reason,
        sampleLogLines: event.samples,
      }),
    );
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'bedrock unavailable, using template', error: String(err) }));
    summary = templatedSummary(event);
    fallback = true;
    fallbackReason = String(err).slice(0, 300);
  }
  // Internal channels (email) also get links to the matching logs; SMS and the public site do not.
  return { summary, fallback, fallbackReason, internalBody: withLogLinks(summary, event.links) };
};
