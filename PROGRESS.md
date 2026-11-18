# Build Progress — 2026-11-17

Branch: `build/notification-system` (off `trunk`). Spec: `.kiro/specs/notification-system/`.

## Status: deployed 2026-11-17 to the demo AWS account, smoke-tested, instances STOPPED

| Phase | State |
|---|---|
| 1 Foundation (VPC, tables + seed, SNS/SQS/DLQ, SES identity) | ✅ built |
| 2 Detection (2 hosts, agent, generator, filters, alarms) | ✅ built; generators smoke-tested locally |
| 3 Orchestration (trigger + Step Functions) | ✅ built; ASL validated by AWS |
| 4 AI processing Lambdas | ✅ built |
| 5 Delivery channels | ✅ built |
| 6 UI + operator API | ✅ built |
| 7 Dashboard + delivery metrics | ✅ built |
| 8 Scripts + README runbook | ✅ built |

Verification so far: `tsc` clean · 15 logic unit tests pass · 9 template assertions
pass (spec acceptance criteria) · `cdk synth` clean ·
`validate-state-machine-definition` OK · both generators emit valid JSON locally.

**Not verified until deployed:** EC2 user data (agent install and generator start),
real Bedrock calls from Lambda, SES send, UI ↔ API in a browser, and the dashboard rendering.

## Changes beyond the original spec

- `NOT_DELIVERED` status: a run where no channel delivered isn't recorded as `SENT`,
  so it can't suppress the next real alert through dedup. (Design doc updated.)
- `scripts/send-test-alarm.ps1`: publishes a synthetic alarm to the SNS topic, for
  instant end-to-end tests without waiting for a burst.
- API stage throttled to 10 rps / 20 burst.

## Live test results (2026-11-17)

Passed: SSM registration (both hosts) · agent + generator log shipping (both) ·
metric filters · alarms ALARM→OK · natural bursts → executions (both hosts) ·
Bedrock summary + guardrail · SES email SENT · website notices · SMS simulated ·
Slack SKIPPED_MISCONFIGURED · toggles affect the next run · dedup (test and
natural, no Bedrock call) · forced failure → FAILED history row · API
auth/validation · CORS restricted to the site origin · DLQ empty · delivery EMF metrics.

Fixed during testing: the guardrail was too strict (it blocked all security
notices); summaries used markdown and said "desktop"; PowerShell 5.1 stderr
handling aborted the deploy.

Not verified: the operator UI JavaScript in a real browser (no browser bridge was available).

## Fleet logs + configurable alert rules (deployed 2026-11-18)

The detection layer was reworked so alerting and log visibility are separate:

- **Real logs.** Ubuntu: Apache + PHP demo app + traffic generator (access log, PHP
  error log). Windows: real Event Log entries (Application 1001, Security 4625 via
  failed LogonUser, System 2001 warnings). Replaces the synthetic JSON generators.
- **Fleet log groups** `/notification-demo/logs/<type>`, with one stream per server.
- **Rules engine** Lambda (subscription filters → DynamoDB rules → counters in the
  `RuleState` table) replaces the 6 hard-coded metric filters and alarms. Alerts are
  published to the same SNS topic, so dedup, Bedrock, guardrail, and channels are unchanged.
- **Operator UI:** Logs tab (Logs Insights across all servers) and Rules tab (CRUD,
  enable/disable, preview). History rows link to their logs.
- **Notifications link to the logs:** email body and Slack get operator UI and
  CloudWatch Logs Insights deep links.
- Verified offline: tsc, 28 unit tests, 13 template tests, `cdk diff` (both
  instances are replaced). The Apache subscription pattern was checked with
  `aws logs test-metric-filter`.
- **Verify after deploy:** Windows agent `event_format: text` line shape and
  `event_ids` filtering for Security 4625; the PHP/Apache setup in user data; the
  console deep link opening correctly; the Logs and Rules tabs in a browser.

- **Live results (2026-11-18):** both instances replaced and running; all 5 log
  groups receive lines. Windows `event_format: text` lines match the parser, and
  Security 4625 events ship (6 forced failed logons via SSM fired
  `windows-logon-failures`). Real alerts went end to end: `web-login-failures`
  (ubuntu-01), `windows-errors`, and `windows-logon-failures` (win-01), all SUCCEEDED,
  with both log links in the email body. API `/logs/hosts`, `/logs/query`, and `/rules`
  work. Still to check by hand: the Logs/Rules tabs in a browser and the console deep link.

## Next

1. Open the operator UI and check that toggles and history render (see README).
2. Before running the instances for long, reduce volume (the default is ≈12 emails/hour):
   QUIET_SECONDS 1800 in the generators, or a 60-minute dedup window in the UI.
3. Optional: switch the instances to CPU credits "standard" (they are "unlimited" now) for a hard cost cap.
4. Merge `build/notification-system` → `trunk`.
