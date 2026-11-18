/** Publishes the notice to the public site: notices/latest.json + notices/history.json. */
import { S3Client, GetObjectCommand, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.SITE_BUCKET!;
const LATEST_KEY = 'notices/latest.json';
const HISTORY_KEY = 'notices/history.json';
const HISTORY_MAX = 25;

interface Input {
  summary: string;
  alarmName: string;
  severity: string;
  eventType: string;
  sourceId: string;
  stateChangeTime: string;
}

function isConflict(err: unknown): boolean {
  const code = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
  // 412 Precondition Failed / 409 ConditionalRequestConflict: another writer won the race.
  return code === 412 || code === 409;
}

async function appendHistory(notice: object): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let items: object[] = [];
    let etag: string | undefined;
    try {
      const cur = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: HISTORY_KEY }));
      etag = cur.ETag;
      items = JSON.parse((await cur.Body?.transformToString()) ?? '[]');
    } catch (err) {
      if (!(err instanceof S3ServiceException && err.name === 'NoSuchKey')) throw err;
    }
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: HISTORY_KEY,
          Body: JSON.stringify([notice, ...items].slice(0, HISTORY_MAX)),
          ContentType: 'application/json',
          CacheControl: 'no-cache',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return;
    } catch (err) {
      if (!isConflict(err)) throw err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt + Math.random() * 100));
    }
  }
  throw new Error('Could not update notices/history.json after repeated conflicts');
}

export const handler = async (event: Input) => {
  const notice = {
    title: `${event.severity} — ${event.alarmName} on ${event.sourceId.replace(/^host:/, '')}`,
    summary: event.summary,
    severity: event.severity,
    publishedAt: new Date().toISOString(),
    eventTime: event.stateChangeTime,
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: LATEST_KEY,
      Body: JSON.stringify(notice),
      ContentType: 'application/json',
      CacheControl: 'no-cache',
    }),
  );
  await appendHistory(notice);
  return { channel: 'website', status: 'SENT', uri: LATEST_KEY };
};
