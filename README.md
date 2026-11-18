# AWS Notification System (Demo)

A municipality-style, multi-channel notification system on AWS. Two EC2 hosts
produce **real logs**: Ubuntu runs Apache + a PHP app (access and PHP error logs),
and Windows ships its Event Logs (Application, System, Security). The CloudWatch
Agent sends them into **fleet log groups** (one per log type, one stream per
server), so 2 servers or 100 are searched from one place: the operator UI's
**Logs** tab. A **rules engine** checks every line against alert rules you edit
in the UI (**Rules** tab). When a server crosses a rule's threshold, an alert goes
SNS → SQS → a **Step Functions** workflow. The
workflow de-duplicates, has **Amazon Bedrock** (Claude Haiku 4.5) write and vet a
plain-language notice, then delivers it through togglable channels: **email
(SES)**, **Slack**, **SMS (SNS)**, and a **public website**. An operator UI flips
channels on/off, edits channel config (e.g. the Slack webhook), and browses history.
Email and Slack notifications link straight to the matching log lines.

Spec: [`.kiro/specs/notification-system/`](.kiro/specs/notification-system/) (requirements, design, tasks).

## Architecture

```
EC2 (SSM-only) + CloudWatch Agent
   Ubuntu: Apache + PHP app + traffic generator   Windows: Event Logs + event generator
   → fleet log groups /notification-demo/logs/<type>  (stream = server id)
        php-error · apache-access · windows-application · windows-system · windows-security
   → subscription filters → Rules engine Lambda
        parse line → match rules (DynamoDB, edited in UI) → count per rule+server+window
        threshold crossed (once per window) → SNS → SQS (+DLQ)
   → Trigger Lambda (adds "view logs" links) → Step Functions (Standard):
        1. Dedup      (DynamoDB: same source+type+severity SENT within window? → skip)
        2. Summarize  (Bedrock Claude Haiku 4.5; templated fallback)
        3. Guardrail  (rule pre-check + Bedrock classifier → withhold if inappropriate)
        4. Get config (DynamoDB toggles + channel settings)
        5. Parallel:  SES email · Slack webhook · SMS (send or simulate) · website (S3)
        6. Write history (+ per-channel delivery metrics)
      Any unrecoverable error → history record status=FAILED

Operator UI (S3 website) → HTTP API (operator key) → Lambda
   Alerts tab: channels, anti-spam, history     → DynamoDB
   Logs tab:   search all servers' logs         → CloudWatch Logs Insights
   Rules tab:  what raises an alert             → DynamoDB
CloudWatch dashboard: rule matches, problem lines by server, recent fleet problems,
   executions, deliveries, DLQ, Lambda errors, CPU
```

## Prerequisites

- Node.js 20+ and AWS CLI v2. The CDK CLI is a dev dependency, so no global install is needed.
- AWS profile **`roitraining`** configured for `us-east-1` (or change `AWS_PROFILE`
  in `lib/config.ts` and the `-AwsProfile` defaults in `scripts/`). Check which
  account it resolves to (`aws sts get-caller-identity`) before deploying.
- Your notification address: copy `local.config.example.json` to
  `local.config.json` (git-ignored) and set `notifyEmail` (and optionally
  `budgetAlertEmail`), or set the `NOTIFY_EMAIL` environment variable.
- **Bedrock:** nothing to enable. Claude Haiku 4.5 is already invocable in the
  account. To check:
  ```powershell
  aws bedrock-runtime converse --profile roitraining --region us-east-1 `
    --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 `
    --messages '[{\"role\":\"user\",\"content\":[{\"text\":\"Reply OK\"}]}]' `
    --query "output.message.content[0].text" --output text
  ```
  If Bedrock ever fails, notices fall back to a template (marked "template (no AI)" in history).

## Deploy

```powershell
npm install
npm run test:all   # unit tests + infrastructure assertions
npm run deploy     # bootstraps CDK if needed, deploys, writes cdk-outputs.json
```

The first deploy takes about 10 minutes, and the Windows host needs another 5–10
minutes to boot and start its generator. Changing a host's setup script (`ec2/`)
replaces that instance on the next deploy, because user data only runs on first boot.

### One-time manual step: SES verification

The deploy creates an SES identity for your `notifyEmail`, and AWS sends
it a verification email. **Click the link**, or no email is delivered. SES stays
in sandbox mode, so it can only send to verified addresses.

> Messages are sent *as* a personal (e.g. `@gmail.com`) address through SES, which fails Gmail's
> DMARC alignment. **Expect them in the spam folder.** Production would use a
> verified domain with DKIM.

## Use it

| What | Where |
|---|---|
| Operator UI | `OperatorUiUrl` output (also in `cdk-outputs.json`) |
| Public notices page | `PublicNoticesUrl` output |
| Workflow runs | `StateMachineConsoleUrl` output: open any execution to see the graph |
| Dashboard | `DashboardUrl` output |

**Operator key.** The UI asks for it once and remembers it in that browser. To get it:

```powershell
aws secretsmanager get-secret-value --secret-id notification-demo/operator-key `
  --query SecretString --output text --profile roitraining
```

**Searching logs (Logs tab).** Pick servers (none = all), log types, text to
match, a time range, and optionally *Problems only* (errors, warnings, failures,
HTTP 4xx/5xx). The generated Logs Insights query is shown and editable (*Run this
query*), and *Open in CloudWatch Logs Insights* opens the same query in the console.

**What alerts (Rules tab).** A rule alerts when **one server** logs at least
*threshold* matching lines within *window* minutes. It fires once per window, and
the workflow's dedup suppresses repeats. A rule matches on any combination of:
log types, minimum level (WARN / ERROR / CRITICAL), text (any of several terms), and
Windows event IDs. *Preview matches* runs the rule as a search over the last hour
before you save it. Seeded rules:

| Rule | Logs | Matches | Alert at | Severity |
|---|---|---|---|---|
| PHP fatal errors | php-error | "PHP Fatal error" | 3 in 5 min | MEDIUM |
| Exploit / CVE probes | apache-access (4xx/5xx) | php-cgi, allow_url_include, wp-login.php, /.env, ../, phpunit | 3 in 5 min | HIGH |
| Failed web logins | php-error | "Failed login" | 5 in 5 min | MEDIUM |
| Windows failed logons | windows-security | event 4625 | 5 in 5 min | HIGH |
| Windows application/system errors | windows-application, windows-system | level ≥ ERROR | 3 in 5 min | LOW |
| Any ERROR in any log | all | level ≥ ERROR | 10 in 5 min | **off** (noisy) |

Not everything alerts: PHP warnings (`report.php`) and Windows System warnings are
in the logs, but no rule fires on them. Rule edits take effect within 30 seconds.

**Log links in notifications.** Email and Slack messages end with *View the logs*
(the operator UI's Logs tab, filtered to that server, rule, and time window) and a
CloudWatch Logs Insights link. SMS and the public website don't get links. Each
history row also has a *View logs* link.

**Triggering notifications**
- *Automatically:* every 15 minutes each host sends a burst (8 events over about 40
  seconds) of one problem kind. Ubuntu: CVE probes, failed logins, or requests that
  crash PHP. Windows: application errors, failed logons (4625), or System warnings.
- *Right now:* `npm run test-alarm`, or
  `powershell -File scripts/send-test-alarm.ps1 -Rule windows-logon-failures`.
  Run it twice within 15 minutes to see `skipped duplicate` in history.

**Channels**
- *Email:* on by default. Addresses are fixed at deploy time (`lib/config.ts`) and
  can't be changed through the API.
- *Slack:* off by default. Paste an incoming webhook URL (`https://hooks.slack.com/...`)
  in the UI, then toggle it on.
- *SMS:* on, in **simulate** mode by default, which logs the message instead of
  sending it. Real SMS needs an SNS origination number and SMS sandbox exit. Without
  them, publish failures are recorded as `simulated`.
- *Website:* on. Writes `notices/latest.json` and `notices/history.json`, which
  `notices.html` renders.

**History statuses:** `sent` (≥1 channel delivered or simulated) · `not delivered`
(every channel disabled or failed) · `skipped duplicate` · `skipped guardrail` ·
`failed` (workflow error; details in the row). Only `sent` counts toward
de-duplication.

**Tuning the generators** (on a host, through SSM Session Manager): set `BURST_LINES`,
`BURST_INTERVAL`, `QUIET_SECONDS` as `Environment=` lines in
`/etc/systemd/system/notification-traffic.service` (Ubuntu), or as machine
environment variables on Windows, then restart the service or scheduled task.

**Adding a server:** add it to `HOSTS` in `lib/config.ts`. Its agent writes to the
same log groups under its own stream name, so it shows up in the Logs tab and every
rule covers it with no other changes.

**Connecting to a host:** EC2 console → instance → Connect → Session Manager.
There are no SSH keys and no inbound rules.

## Cost control

```powershell
npm run stop      # stop both EC2 hosts (keeps everything else)
npm run start     # start them again
npm run status    # show their state
npm run destroy   # delete the whole stack
```

Running cost is roughly the two instances (t3.small Ubuntu + t3.medium Windows,
with the Windows license), two public IPv4 addresses (about $7/month), and pennies
for Lambda, Step Functions, DynamoDB, Bedrock, and CloudWatch (log ingestion
$0.50/GB, Logs Insights $0.005/GB scanned, one custom metric per rule). There's no NAT
gateway and no VPC endpoints. Stopped instances cost only their EBS volumes and
public IPs. `destroy` removes everything: tables, buckets, and log groups are
set to delete.

## Security notes (demo scope)

- EC2: SSM Session Manager only, with no key pair and no inbound rules, and IMDSv2 required.
- The operator API needs the `x-operator-key` header. The Slack webhook must be on
  `hooks.slack.com`, and email addresses are read-only through the API, so the API
  can't redirect notifications to arbitrary destinations. Production should use
  Cognito or IAM auth instead of a shared key.
- The website bucket is public-read by design (it's the public notices site). It
  holds only the UI files and published notices.
- Each Lambda has its own least-privilege role. For example, Bedrock access covers
  only the Haiku 4.5 inference profile plus its routed regions.

## Project layout

```
app/cdk-app.ts              CDK entry point
lib/                        stack + constructs (log-analytics, detection, workflow, operator-ui, dashboard),
                            config.ts (hosts, default alert rules)
lambda/                     handlers (rules-engine, api, workflow steps)
lambda/shared/              logic.ts + logs.ts: pure, unit-tested logic (parsing, rules, queries, links)
ec2/ubuntu/                 PHP demo app (app/*.php) + traffic.sh
ec2/windows/                generator.ps1 (real Event Log entries)
ui/                         operator console (index.html, app.js) + public notices.html
scripts/                    deploy / destroy / instances / send-test-alarm (PowerShell)
test/                       logic.test.ts + logs.test.ts (unit), template.test.ts (infra assertions)
```
