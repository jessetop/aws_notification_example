# Notification System — Requirements

## Overview

A municipality-style, multi-channel notification system on AWS. Managed hosts
emit realistic error and CVE-style log lines; CloudWatch ingests and detects
threshold breaches, raises alarms, and each alarm is fanned out through an SNS
topic into an SQS buffer. A **Step Functions** workflow orchestrates every
notification: Amazon Bedrock summarizes and vets the message, a de-duplication
check prevents accidental spam, and the result is delivered through any
combination of **email (SES)**, **Slack**, **SMS (SNS)**, and a **website
update** — each channel togglable at runtime from an operator UI. A CloudWatch
dashboard surfaces the health of detection and delivery, and each workflow run
is visible as an inspectable Step Functions execution.

## Scope

**In scope:** AWS CDK (TypeScript) infrastructure; the Step Functions workflow;
Lambda functions (trigger, summarize, guardrail, dedup, per-channel delivery,
config/history API); the operator UI; two EC2 detection hosts (Windows + Ubuntu)
with the CloudWatch Agent and a synthetic error generator; and CloudWatch
telemetry.

**Out of scope:** production hardening beyond what is noted here; production
carrier approval for SMS; a real PHP application (a synthetic error generator
stands in for it); multi-account / multi-region fan-out.

## Detection & Ingestion

### Host log emission

WHEN a managed host (Windows or Ubuntu) is running
THE SYSTEM SHALL emit synthetic error/CVE-style log lines on a configurable cadence

WHEN a host emits synthetic events
THE SYSTEM SHALL emit them in bursts separated by quiet periods, so alarms return to OK between bursts and can fire again

WHEN a host emits a log line
THE SYSTEM SHALL ship it to CloudWatch Logs via the CloudWatch Agent into a host-scoped log group

### Detection

WHEN ingested log lines for a host exceed a metric-filter threshold within the evaluation window
THE SYSTEM SHALL transition the corresponding CloudWatch Alarm to ALARM state

WHEN a CloudWatch Alarm transitions to ALARM state
THE SYSTEM SHALL publish the alarm detail to an SNS topic

WHEN an alarm's metric receives no data in an evaluation period
THE SYSTEM SHALL treat the missing data as not breaching, so the alarm returns to OK

### Buffering

WHEN an alarm event is published to the SNS topic
THE SYSTEM SHALL enqueue a copy of the event into an SQS queue for durable buffering

WHEN a message cannot be processed after the configured number of receive attempts
THE SYSTEM SHALL route the message to a dead-letter queue and surface the failure on the dashboard

## Orchestration (Step Functions)

### Execution trigger

WHEN an event is present in the SQS queue
THE SYSTEM SHALL start a Step Functions execution to process that single event

WHEN a Step Functions execution runs
THE SYSTEM SHALL expose each step (summarize, guardrail, dedup, fan-out, history) as an inspectable state in the execution graph

### Resilience

WHEN a task in the workflow fails transiently
THE SYSTEM SHALL retry it according to the configured retry policy before failing the execution

WHEN a Step Functions execution fails
THE SYSTEM SHALL record the failure for operator review without losing the buffered event

WHEN any step after the trigger fails unrecoverably
THE SYSTEM SHALL write a history record with status FAILED and the error detail before ending the execution

## AI Summarization & Guardrail

### Summarization

WHEN the workflow processes an alarm event that is not a duplicate
THE SYSTEM SHALL call Amazon Bedrock to produce a concise, human-readable summary of the event

WHEN Amazon Bedrock is unavailable or model access is not enabled
THE SYSTEM SHALL fall back to a templated summary derived from the raw event and continue the workflow

### Appropriateness

WHEN the workflow has produced a summary
THE SYSTEM SHALL run a guardrail check to determine whether the message is appropriate for end-user delivery

WHEN the guardrail check determines the message is not appropriate
THE SYSTEM SHALL withhold the message from end users and record the reason in history

## Anti-Spam / De-duplication

### Duplicate detection

WHEN the workflow starts processing an event
THE SYSTEM SHALL check for duplicates before any AI summarization, so duplicates incur no Bedrock cost

WHEN the de-duplication check runs
THE SYSTEM SHALL query recently stored messages for the same source and dedup hash whose status is SENT

WHEN a matching SENT message exists within the configured de-duplication window
THE SYSTEM SHALL skip delivery and record the event as skipped

WHEN previous events for a source were skipped (duplicate, guardrail) or failed
THE SYSTEM SHALL NOT count them toward de-duplication, so a continuously alarming source is still notified once per window

WHEN no matching recent message exists
THE SYSTEM SHALL proceed to delivery

## Delivery Channels

### Channel selection

WHEN the workflow reaches the delivery stage
THE SYSTEM SHALL read each channel's enabled state and configuration from the config table

WHEN a channel is disabled
THE SYSTEM SHALL skip that channel for the current execution and record it as skipped

### Email (SES)

WHEN the email channel is enabled and the message passed the guardrail
THE SYSTEM SHALL send the summary to the configured recipient address via Amazon SES

### Slack

WHEN the Slack channel is enabled and a webhook URL is configured
THE SYSTEM SHALL post the summary to the configured Slack incoming webhook

WHEN the Slack channel is enabled but no webhook URL is configured
THE SYSTEM SHALL record the channel as misconfigured and skip Slack delivery

### SMS (SNS)

WHEN the SMS channel is enabled
THE SYSTEM SHALL attempt to publish the summary via Amazon SNS SMS

WHEN SNS SMS delivery is not permitted (for example sandbox or spending-limit restrictions)
THE SYSTEM SHALL fall back to logging a simulated delivery and record it as simulated

### Website update

WHEN the website channel is enabled
THE SYSTEM SHALL write the latest summarized message to website content that the public site renders

## Configuration & Operator UI

### Channel toggles

WHEN an operator calls the config/history API (other than the health check)
THE SYSTEM SHALL require a valid operator key and reject the request otherwise

WHEN an operator opens the UI
THE SYSTEM SHALL display the on/off state of each channel

WHEN an operator toggles a channel on or off
THE SYSTEM SHALL persist the change and apply it to subsequent executions

### Channel configuration

WHEN an operator edits a channel's configuration (for example the Slack webhook URL) in the UI
THE SYSTEM SHALL persist the configuration and use it for subsequent deliveries

WHEN the Slack webhook URL has not been set
THE SYSTEM SHALL present a placeholder value and allow the operator to set it

WHEN an operator submits a Slack webhook URL that does not start with `https://hooks.slack.com/`
THE SYSTEM SHALL reject the change

WHEN an operator attempts to change the email sender or recipient addresses through the API
THE SYSTEM SHALL reject the change (addresses are deploy-time configuration only)

### History

WHEN an operator opens the history view in the UI
THE SYSTEM SHALL display recent messages with their status (sent/skipped) and the channels used

## Observability

### Dashboard

WHEN the dashboard is opened
THE SYSTEM SHALL display EC2 metrics, metric-filter counts, alarm states, and per-channel delivery success and failure counts

WHEN a delivery channel fails repeatedly
THE SYSTEM SHALL surface the failure rate on the dashboard

## Resilience, Safety & Cost Control

### Least privilege & access

WHEN EC2 instances are provisioned
THE SYSTEM SHALL permit access via AWS Systems Manager Session Manager only, with no SSH key pair and no inbound security-group rules

WHEN EC2 instances need outbound access (agent install, SSM, CloudWatch)
THE SYSTEM SHALL use a public subnet with a public IP and no inbound rules, rather than a NAT gateway or interface VPC endpoints, to minimize cost

### Teardown & cost

WHEN the operator runs the teardown command
THE SYSTEM SHALL remove all provisioned AWS resources

WHEN the operator invokes the stop command
THE SYSTEM SHALL stop the EC2 instances without deleting them to reduce ongoing cost
