# Notification System — Tasks

Phased implementation. Tasks within a phase may run once their dependencies are
met; independent tasks in the same phase can be done in parallel. Mark each
`- [ ]` as it completes.

## Phase 1 — Foundation

### 1.1 CDK app and project skeleton
Required. Depends on: none.
Description: `app/cdk-app.ts` instantiates the stack(s); add shared config
(profile `roitraining`, region `us-east-1`, Bedrock inference profile
`us.anthropic.claude-haiku-4-5-20251001-v1:0`, recipient email
`<notifyEmail from local.config.json>`, Slack placeholder).
Acceptance criteria:
- `npx cdk synth` runs with no errors
- App + stack files compile under `tsc --noEmit`

### 1.2 VPC — public subnets only (no NAT, no endpoints)
Required. Depends on: 1.1.
Description: VPC with 2 AZs and public subnets only. Hosts get public IPs for
outbound (agent install, SSM, CloudWatch) but their security group has zero
inbound rules. No NAT gateway and no interface endpoints (saves ≈$70/month and
avoids private-subnet install failures).
Acceptance criteria:
- No NAT gateways and no VPC endpoints in the synthesized template
- Host security group has no ingress rules

### 1.3 DynamoDB `Notifications` table (history + dedup)
Required. Depends on: 1.1.
Description: Table with PK `sourceId`, SK `createdAt` (Number), GSI `RecentIndex`
(PK `gsiPk`, SK `createdAt`), and a 90-day TTL on `ttl`.
Acceptance criteria:
- Table, GSI, and TTL present in the template
- On-demand billing mode

### 1.4 DynamoDB `Config` table + seed
Required. Depends on: 1.1.
Description: Table PK `entity`, SK `key`. Seed channel rows on deploy:
email enabled to `<notifyEmail from local.config.json>`; slack disabled with webhook
`https://hooks.slack.com/services/REPLACE_ME`; sms enabled with
`simulate: true`; website enabled. Plus `settings/dedup` = `windowMinutes: 15`.
Acceptance criteria:
- Seed items created on first deploy (idempotent on re-deploy)
- Slack webhook stored as the REPLACE_ME placeholder

### 1.5 SNS topic + SQS queue + DLQ
Required. Depends on: 1.1.
Description: SNS topic (alarm target); SQS queue subscribed to it with a redrive
policy to a DLQ after 5 receives; SQS visibility timeout sized for SFN duration.
Acceptance criteria:
- Alarm → SNS → SQS subscription wired
- DLQ exists and is referenced by the queue redrive policy

## Phase 2 — Detection

### 2.1 Synthetic error generator scripts
Required. Depends on: none (code only).
Description: `ec2/error-generator/generator.ps1` (Windows) and `generator.sh`
(Ubuntu) emit CVE-scan, auth-failure, and app-exception log lines to the
CloudWatch Agent log file, each tagged with host id, event type, and severity.
They alternate a burst (one random event type, ~6 lines over ~1 minute) with a
quiet period (INFO lines only) so alarms return to OK and can fire again.
Cadence configurable via env var.
Acceptance criteria:
- Both scripts emit all three event types
- Lines are single-line JSON so metric filters can pattern-match
- Bursts are separated by quiet periods; durations configurable without code changes

### 2.2 Windows EC2 instance (SSM-only)
Required. Depends on: 1.2, 2.1.
Description: `t3.medium` in a public subnet with a public IP, SSM-managed IAM
role, no key pair, no inbound rules. User-data installs the CloudWatch Agent and the generator,
points the agent at a host log group, and starts the generator.
Acceptance criteria:
- No key pair and no inbound security group rules
- IAM role grants only SSM + CloudWatch Logs PutLogEvents for its group
- Instance appears as a managed instance in Systems Manager

### 2.3 Ubuntu EC2 instance (SSM-only)
Required. Depends on: 1.2, 2.1.
Description: Same as 2.2 for Ubuntu 24.04 on `t3.small`; user-data installs the
agent and runs the generator as a systemd service.
Acceptance criteria:
- Same least-privilege and SSM-only properties as 2.2
- CloudWatch Logs group receives lines from the host

### 2.4 CloudWatch log groups + metric filters
Required. Depends on: 2.2, 2.3.
Description: One log group per host; metric filters turn the event-type patterns
into metrics in namespace `App/Notifications`, dimension `host`.
Acceptance criteria:
- Each pattern produces a metric for `CveHits`, `AuthFail`, `AppException`
- Metric values increment when the generator emits matching lines

### 2.5 CloudWatch alarms wired to SNS
Required. Depends on: 2.4, 1.5.
Description: One alarm per host/event-type (60 s period, 1 evaluation period,
threshold ≥ 3, `treatMissingData: notBreaching`); ALARM action publishes to the
SNS topic from 1.5.
Acceptance criteria:
- Alarms have the SNS topic as their alarm action
- Emitted lines push the alarm to ALARM within the evaluation period
- Alarms return to OK during the generator's quiet period

## Phase 3 — Orchestration (Step Functions)

### 3.1 Trigger Lambda (SQS → StartExecution)
Required. Depends on: 1.5.
Description: SQS-triggered Lambda, batch size 1, parses the SNS-wrapped alarm
payload, derives `sourceId`/`eventType`/`severity`, and starts the SFN execution
with the contract from design `SQS message → Trigger Lambda`.
Acceptance criteria:
- One SFN execution starts per SQS message
- Invalid payloads are moved to the DLQ, not retried forever
- Lambda role allows only `states:StartExecution` on the workflow

### 3.2 Step Functions workflow definition
Required. Depends on: 3.1.
Description: Standard workflow: Dedup → Choice (skip if duplicate) → Summarize
→ Guardrail → Choice (skip if inappropriate) → GetConfig → Parallel fan-out
(email/slack/sms/website, each a Choice on enabled) → WriteHistory. Each Lambda
task has a Retry block; channel branches catch failures and record per-channel
status. The whole flow is wrapped in a single-branch Parallel whose Catch writes
a `FAILED` history record, then fails the execution.
Acceptance criteria:
- Graph matches the design data flow
- Duplicates are detected before any Bedrock call
- A duplicate or guardrail-fail short-circuits to history and ends cleanly
- Failed channel does not fail the whole execution
- An unrecoverable error writes a FAILED history record

### 3.3 Workflow IAM permissions
Required. Depends on: 3.2, 4.1–4.4, 5.1–5.4.
Description: The workflow role may invoke the task Lambdas and, for the native
SES integration, call `ses:SendEmail`. History writes go through the
WriteHistory Lambda.
Acceptance criteria:
- Each integration has least-privilege grants in the synthesized role

## Phase 4 — AI Processing Lambdas

### 4.1 Summarize Lambda + Bedrock fallback
Required. Depends on: 1.1.
Description: Calls Bedrock Claude Haiku 4.5 (inference profile
`us.anthropic.claude-haiku-4-5-20251001-v1:0`, Converse API) with the
municipality-notice system prompt; on any Bedrock error returns a templated
summary with `fallback: true`.
Acceptance criteria:
- Returns a summary for a sample event with Bedrock enabled
- Returns a templated fallback when Bedrock is unavailable
- Lambda role allows `bedrock:InvokeModel` only on the inference-profile ARN and
  the Haiku 4.5 foundation-model ARNs in us-east-1, us-east-2, and us-west-2

### 4.2 Guardrail Lambda
Required. Depends on: 1.1.
Description: Rule pre-check + Bedrock classification; returns
`{ appropriate, reason }`. Withholds messages that are unsafe/ambiguous.
Acceptance criteria:
- Safe sample passes; unsafe sample is flagged with a reason
- Degrades to permissive when Bedrock is unavailable (noted in reason)

### 4.3 Dedup Lambda
Required. Depends on: 1.3, 1.4.
Description: Runs first in the workflow. Computes `dedupHash`, queries recent
`Notifications` items for the `sourceId` within `settings/dedup.windowMinutes`
whose `status` is `SENT` and whose hash matches, returns `{ duplicate }`.
Acceptance criteria:
- A repeat event within the window is flagged duplicate
- An event after the window is not
- Skipped or failed records never count as duplicates
- Reads use only `Query` on the table (plus `GetItem` on Config for the window)

### 4.4 Config Lambda
Required. Depends on: 1.4.
Description: Returns all channel toggles + config for the workflow's fan-out.
Acceptance criteria:
- Returns the contract from the design task table
- Reads only the `Config` table

### 4.5 Wire processing tasks into the workflow
Required. Depends on: 3.2, 4.1, 4.2, 4.3, 4.4.
Description: Point the SFN task ARNs at the implemented Lambdas and validate
input/output wiring.
Acceptance criteria:
- `cdk synth` includes all four task ARNs
- A dry run of the workflow with a sample event flows dedup→summarize→guardrail

## Phase 5 — Delivery Channels

### 5.1 Email channel via SES
Required. Depends on: 1.4, 3.2.
Description: Native Step Functions SES `SendEmail` task using `config.email`;
sender and recipient `<notifyEmail from local.config.json>`. Record per-channel status.
Acceptance criteria:
- Enabled email channel sends to the verified address when run
- Per-channel `SENT`/`SKIPPED` recorded into history

### 5.2 Slack Lambda
Required. Depends on: 3.2.
Description: POSTs the summary to `config.slack.webhookUrl`; if the URL is the
placeholder or empty, returns `SKIPPED_MISCONFIGURED` (not a failure).
Acceptance criteria:
- Posts to a real webhook when one is set via the UI
- Placeholder/empty webhook is skipped cleanly with a recorded reason

### 5.3 SMS Lambda
Required. Depends on: 3.2.
Description: Publishes via SNS SMS; on sandbox/limit rejection logs a simulated
send and returns `SIMULATED`.
Acceptance criteria:
- Permitted SMS sends; restricted SMS returns simulated with the payload logged
- Per-channel status reflects which path was taken

### 5.4 Website Lambda
Required. Depends on: 1.1, 3.2.
Description: Writes `notices/latest.json` (latest notice) and appends to
`notices/history.json` in the UI bucket for the public site to render. The
history append uses S3 conditional writes (If-Match on the ETag, or
If-None-Match on first write) with retry, so parallel executions do not lose
updates.
Acceptance criteria:
- `notices/latest.json` updates on each website-enabled execution
- Concurrent appends do not drop entries
- Lambda can write only its bucket path prefix

### 5.5 Wire delivery branches into the workflow
Required. Depends on: 3.2, 5.1, 5.2, 5.3, 5.4.
Description: Add the Parallel fan-out with a per-channel Choice on `enabled`
and per-branch error catchers that record channel status.
Acceptance criteria:
- Toggling a channel off results in a skipped branch visible in the graph
- A failing channel records its status and the execution still completes

## Phase 6 — UI & Config API

### 6.1 API Gateway HTTP API + routes
Required. Depends on: 1.4, 1.3.
Description: HTTP API v2 with routes `GET /channels`, `PUT /channels/{name}`,
`PUT /settings/dedup`, `GET /history`, `GET /health`, integrated to the
config/history Lambda. A Secrets Manager secret holds a generated operator key.
Acceptance criteria:
- Routes exist and integrate to the Lambda
- API URL and operator-key secret name are stack outputs

### 6.2 Config/History Lambda
Required. Depends on: 6.1.
Description: Implements the API. Every route except `/health` requires a valid
`x-operator-key` header. `PUT` merges partial config (e.g. setting only the
Slack webhook) after validation: Slack webhook must start with
`https://hooks.slack.com/`; email addresses are read-only; SMS phone number must
be E.164 or empty; unknown keys rejected. `GET /history` queries the
`RecentIndex` GSI, newest first.
Acceptance criteria:
- Missing/wrong operator key returns 401
- `PUT /channels/slack { config: { webhookUrl } }` updates only that field
- Non-Slack webhook URLs and email-address edits are rejected with 400
- `GET /history?limit=50` returns up to 50 newest messages
- Role limited to the two DynamoDB tables and reading the operator-key secret

### 6.3 S3 static UI + deployment
Required. Depends on: 6.1.
Description: S3 bucket (static website hosting) holding `index.html`, `app.js`,
`style.css`; bucket website URL is a stack output. Deployment uploads the built
UI assets.
Acceptance criteria:
- Bucket website URL serves `index.html`
- UI assets deployed on `cdk deploy` (or via a deploy script)

### 6.4 UI features: toggles, Slack webhook editor, history
Required. Depends on: 6.3, 6.2.
Description: UI prompts for the operator key (kept in the browser), loads
channels, lets the operator toggle each on/off, edit the Slack webhook URL (and
other channel config), and browse the message history with status and channels
used. A separate public `notices.html` renders `notices/latest.json` and
`notices/history.json`.
Acceptance criteria:
- Toggling a channel persists and is reflected on reload
- Setting the Slack webhook updates `config.slack.webhookUrl`
- History list shows recent messages with status + channels

## Phase 7 — Dashboard & Observability

### 7.1 Delivery + DLQ metrics
Required. Depends on: 1.5, 5.5.
Description: WriteHistory emits per-channel delivery metrics (namespace
`App/Notifications/Delivery`, dimensions `Channel`, `Status`) via CloudWatch
Embedded Metric Format; SQS DLQ depth metric.
Acceptance criteria:
- Success/fail counts per channel are queryable
- DLQ depth appears as a metric

### 7.2 CloudWatch dashboard
Required. Depends on: 2.5, 7.1.
Description: Dashboard with EC2 metrics, metric-filter counts, alarm states,
per-channel delivery counts/errors, and DLQ depth. Dashboard URL is a stack
output.
Acceptance criteria:
- Dashboard renders all listed widgets
- Dashboard name/URL is a stack output

## Phase 8 — Deploy, Runbook, Teardown

### 8.1 Bootstrap + deploy/destroy scripts
Required. Depends on: all prior.
Description: `scripts/deploy.ps1` (bootstrap-if-needed + `cdk deploy --all`),
`scripts/destroy.ps1`, `scripts/stop-instances.ps1`. Package scripts wrap them.
Acceptance criteria:
- `npm run deploy` bootstraps if needed and deploys all stacks
- `npm run destroy` removes all stacks
- Stop script halts both EC2 instances without deleting them

### 8.2 Runbook (README)
Required. Depends on: 8.1.
Description: Prereqs (SES identity verification of `<notifyEmail from local.config.json>`;
Bedrock is already available — note how to check it), how to fetch the operator
key, deploy steps, how to trigger a
notification (start the generator / force an alarm), where to view the SFN
execution and dashboard, how to toggle channels / set the Slack webhook, and
how to stop/teardown.
Acceptance criteria:
- A new operator can deploy, trigger, observe, and tear down from the README alone
- SES verification is called out as a manual one-time step; spam-folder caveat noted

### 8.3 SES identity verification
Required. Depends on: 5.1.
Description: CDK creates SES email identity for `<notifyEmail from local.config.json>`;
verification still requires clicking the email link — documented in the runbook.
Acceptance criteria:
- Identity resource exists post-deploy
- Runbook notes the one-time link-click confirmation

### 8.4 Final synth + smoke
Required. Depends on: 8.1.
Description: Run `cdk synth` clean; if deploying, run the smoke test (trigger
generator, confirm a SFN execution, confirm dedup, toggle a channel, view UI).
Acceptance criteria:
- `cdk synth` succeeds with no errors
- (If deployed) one full notification round-trip visible end to end
