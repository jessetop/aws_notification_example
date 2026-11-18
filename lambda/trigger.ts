/** SQS (batch size 1) → Step Functions StartExecution, adding deep links to the relevant logs. */
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { SFNClient, StartExecutionCommand, ExecutionAlreadyExists } from '@aws-sdk/client-sfn';
import { parseAlarmRecord } from './shared/logic';
import { buildLogLinks } from './shared/logs';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const linkOpts = {
  uiBaseUrl: process.env.OPERATOR_UI_URL!,
  region: process.env.AWS_REGION ?? 'us-east-1',
  groupPrefix: process.env.LOG_GROUP_PREFIX!,
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const input = parseAlarmRecord(record.body, Date.now());
      input.links = buildLogLinks(input.logs, linkOpts);
      // SQS message IDs are unique per message, so a redelivery of the same
      // message maps to the same execution name and is not double-processed.
      const name = `${input.eventType}-${record.messageId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
      try {
        await sfn.send(new StartExecutionCommand({ stateMachineArn: STATE_MACHINE_ARN, name, input: JSON.stringify(input) }));
        console.log(JSON.stringify({ msg: 'started', name, sourceId: input.sourceId, eventType: input.eventType }));
      } catch (err) {
        if (err instanceof ExecutionAlreadyExists) {
          console.log(JSON.stringify({ msg: 'already started', name }));
        } else {
          throw err;
        }
      }
    } catch (err) {
      // Reported as a failure: SQS retries it, then the redrive policy moves it to the DLQ.
      console.error(JSON.stringify({ msg: 'failed', messageId: record.messageId, error: String(err) }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
