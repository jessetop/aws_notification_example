/** Runs first: was the same alert SENT for this source within the window? */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, getDedupWindowMinutes, NOTIFICATIONS_TABLE } from './shared/ddb';
import { dedupHash, windowStart } from './shared/logic';

export const handler = async (event: { sourceId: string; eventType: string; severity: string }) => {
  const hash = dedupHash(event.sourceId, event.eventType, event.severity);
  const windowMinutes = await getDedupWindowMinutes();
  const res = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'sourceId = :s AND createdAt >= :from',
      // Only SENT records count; skipped/failed ones must not extend the window.
      FilterExpression: 'dedupHash = :h AND #st = :sent',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':s': event.sourceId,
        ':from': windowStart(Date.now(), windowMinutes),
        ':h': hash,
        ':sent': 'SENT',
      },
      ScanIndexForward: false,
    }),
  );
  const last = res.Items?.[0];
  return {
    duplicate: Boolean(last),
    dedupHash: hash,
    windowMinutes,
    ...(last ? { lastSentAt: last.createdAt as number } : {}),
  };
};
