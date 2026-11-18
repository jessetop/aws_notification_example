import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CHANNEL_NAMES } from './logic';
import type { AlertRule } from './logs';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE ?? '';
export const CONFIG_TABLE = process.env.CONFIG_TABLE ?? '';

export interface ChannelRow {
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function getChannels(): Promise<Record<string, ChannelRow>> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'entity = :e',
      ExpressionAttributeValues: { ':e': 'channel' },
    }),
  );
  const out: Record<string, ChannelRow> = {};
  for (const name of CHANNEL_NAMES) out[name] = { enabled: false, config: {} };
  for (const item of res.Items ?? []) {
    out[item.key as string] = { enabled: Boolean(item.enabled), config: (item.config as Record<string, unknown>) ?? {} };
  }
  return out;
}

export async function getDedupWindowMinutes(defaultMinutes = 15): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { entity: 'settings', key: 'dedup' } }));
  const w = Number(res.Item?.windowMinutes);
  return Number.isFinite(w) && w > 0 ? w : defaultMinutes;
}

/** Alert rules live in the config table as entity="rule", key=<rule id>. */
export async function getRules(): Promise<AlertRule[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'entity = :e',
      ExpressionAttributeValues: { ':e': 'rule' },
    }),
  );
  return (res.Items ?? []).map(({ entity, key, updatedAt, ...rest }) => ({ ...rest, id: key }) as AlertRule);
}
