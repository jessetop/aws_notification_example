/** Appropriateness check: deterministic rules first, then a Bedrock classifier. */
import { converse } from './shared/bedrock';
import { parseGuardrailReply, ruleCheck } from './shared/logic';

const SYSTEM = `You review notices before a city government's IT department sends them to staff and residents by email, SMS, Slack, and its website.
These notices exist to report security and reliability events on city servers (vulnerability scans, failed sign-ins,
application errors). That subject matter, naming the affected server, and stating the severity are EXPECTED and appropriate.
Mark a notice NOT appropriate only if it:
- contains personal data, usernames, credentials, keys, or other secrets;
- reveals IP addresses, network layout, or exploit/attack details someone could reuse;
- contains profanity or abusive language;
- uses panic-inducing or speculative language (e.g. blaming specific attackers, claiming data was stolen without evidence);
- is so vague or contradictory that it would mislead readers.
Reply with JSON only: {"appropriate": true|false, "reason": "<one short sentence>"}`;

export const handler = async (event: { summary: string; fallback?: boolean }) => {
  const rules = ruleCheck(event.summary ?? '');
  if (!rules.appropriate) return rules;
  if (event.fallback) return { appropriate: true, reason: 'Rule check passed; AI review skipped (templated summary)' };
  try {
    const verdict = parseGuardrailReply(await converse(SYSTEM, event.summary, 150));
    if (verdict) return verdict;
    return { appropriate: true, reason: 'Rule check passed; AI review returned an unparseable reply' };
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'bedrock unavailable for guardrail', error: String(err) }));
    return { appropriate: true, reason: 'Rule check passed; AI review skipped (Bedrock unavailable)' };
  }
};
