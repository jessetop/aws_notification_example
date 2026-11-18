/** Publishes the notice via SNS SMS, or logs a simulated send. */
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { truncateSms } from './shared/logic';

const sns = new SNSClient({});

interface Input {
  summary: string;
  alarmName: string;
  config: { simulate?: boolean; phoneNumber?: string };
}

export const handler = async (event: Input) => {
  const message = truncateSms(`City IT notice: ${event.summary}`);
  const phone = event.config?.phoneNumber ?? '';
  if (event.config?.simulate !== false || !phone) {
    console.log(JSON.stringify({ msg: 'SIMULATED SMS', to: phone || '(none configured)', message }));
    return { channel: 'sms', status: 'SIMULATED', reason: phone ? 'simulate mode on' : 'no phone number configured' };
  }
  try {
    const res = await sns.send(
      new PublishCommand({
        PhoneNumber: phone,
        Message: message,
        MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } },
      }),
    );
    return { channel: 'sms', status: 'SENT', messageId: res.MessageId };
  } catch (err) {
    // Sandbox, missing origination number, or spend limit: demonstrate the path anyway.
    console.log(JSON.stringify({ msg: 'SIMULATED SMS (publish not permitted)', to: phone, message, error: String(err) }));
    return { channel: 'sms', status: 'SIMULATED', reason: String(err).slice(0, 200) };
  }
};
