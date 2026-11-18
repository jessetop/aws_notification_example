/** Writes the history record and emits per-channel delivery metrics (EMF). */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, NOTIFICATIONS_TABLE } from './shared/ddb';
import { channelsToMap, dedupHash, deliveryMetricLines, finalStatus } from './shared/logic';

const TTL_DAYS = 90;
const METRIC_NAMESPACE = process.env.DELIVERY_METRIC_NAMESPACE ?? 'App/Notifications/Delivery';

interface Input {
  status: string;
  sourceId: string;
  eventType: string;
  severity: string;
  alarmName: string;
  rawEvent: string;
  dedup?: { dedupHash?: string; lastSentAt?: number };
  ai?: { summary?: string; fallback?: boolean };
  guardrail?: { appropriate?: boolean; reason?: string };
  channels?: unknown;
  error?: { Error?: string; Cause?: string };
  logs?: unknown;
  links?: unknown;
}

export const handler = async (event: Input) => {
  const now = Date.now();
  const channels = channelsToMap(event.channels);
  const messageId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: {
        sourceId: event.sourceId ?? 'unknown',
        createdAt: now,
        messageId,
        gsiPk: 'RECENT',
        status: finalStatus(event.status, channels),
        dedupHash: event.dedup?.dedupHash ?? dedupHash(event.sourceId, event.eventType, event.severity),
        eventType: event.eventType,
        severity: event.severity,
        alarmName: event.alarmName,
        rawEvent: event.rawEvent,
        summary: event.ai?.summary,
        aiFallback: event.ai?.fallback,
        guardrailReason: event.guardrail?.reason,
        lastSentAt: event.dedup?.lastSentAt,
        channels,
        logs: event.logs,
        links: event.links,
        error: event.error ? `${event.error.Error ?? 'Error'}: ${(event.error.Cause ?? '').slice(0, 1000)}` : undefined,
        ttl: Math.floor(now / 1000) + TTL_DAYS * 86400,
      },
    }),
  );
  for (const line of deliveryMetricLines(METRIC_NAMESPACE, channels, now)) console.log(line);
  return { recorded: true, messageId };
};
