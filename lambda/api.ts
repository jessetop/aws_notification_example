/** Operator API: channel toggles/config, dedup setting, history, alert rules, and fleet log queries. */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetQueryResultsCommand,
  ResourceNotFoundException,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CONFIG_TABLE, ddb, getChannels, getDedupWindowMinutes, getRules, NOTIFICATIONS_TABLE } from './shared/ddb';
import { safeEqual, validateChannelUpdate, validateDedupWindow, ValidationError } from './shared/logic';
import {
  buildInsightsQuery,
  consoleInsightsUrl,
  LOG_TYPES,
  logGroupName,
  RULE_ID_RE,
  validateLogQuery,
  validateRule,
} from './shared/logs';

const secrets = new SecretsManagerClient({});
const cwl = new CloudWatchLogsClient({});
const GROUP_PREFIX = process.env.LOG_GROUP_PREFIX!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
let cachedKey: { value: string; at: number } | undefined;

async function operatorKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.at < 5 * 60_000) return cachedKey.value;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.OPERATOR_KEY_SECRET_ARN! }));
  cachedKey = { value: res.SecretString ?? '', at: Date.now() };
  return cachedKey.value;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Body must be valid JSON');
  }
}

async function updateChannel(name: string, body: unknown) {
  const update = validateChannelUpdate(name, body);
  const cur = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { entity: 'channel', key: name } }));
  const item = {
    entity: 'channel',
    key: name,
    enabled: update.enabled ?? Boolean(cur.Item?.enabled),
    config: { ...((cur.Item?.config as object) ?? {}), ...update.config },
    updatedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }));
  return { name, enabled: item.enabled, config: item.config };
}

async function history(limitParam?: string) {
  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);
  const res = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      IndexName: 'RecentIndex',
      KeyConditionExpression: 'gsiPk = :p',
      ExpressionAttributeValues: { ':p': 'RECENT' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (res.Items ?? []).map(({ rawEvent, gsiPk, ttl, ...rest }) => rest);
}

// ---------- Logs ----------

/** Every host that has shipped logs, with the log types it ships and when it was last seen. */
async function fleetHosts() {
  const hosts = new Map<string, { host: string; logTypes: string[]; lastEventAt: number }>();
  await Promise.all(
    LOG_TYPES.map(async (type) => {
      let nextToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        let res;
        try {
          res = await cwl.send(
            new DescribeLogStreamsCommand({ logGroupName: logGroupName(GROUP_PREFIX, type), orderBy: 'LastEventTime', descending: true, nextToken }),
          );
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return;
          throw err;
        }
        for (const s of res.logStreams ?? []) {
          if (!s.logStreamName) continue;
          const h = hosts.get(s.logStreamName) ?? { host: s.logStreamName, logTypes: [], lastEventAt: 0 };
          h.logTypes.push(type);
          h.lastEventAt = Math.max(h.lastEventAt, s.lastEventTimestamp ?? s.lastIngestionTime ?? 0);
          hosts.set(s.logStreamName, h);
        }
        nextToken = res.nextToken;
        if (!nextToken) break;
      }
    }),
  );
  return [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host));
}

async function startLogQuery(body: unknown) {
  const { scope, limit, query: raw } = validateLogQuery(body, Date.now());
  const query = raw ?? buildInsightsQuery(scope, limit);
  const groups = scope.logTypes.map((t) => logGroupName(GROUP_PREFIX, t));
  const res = await cwl.send(
    new StartQueryCommand({
      logGroupNames: groups,
      startTime: Math.floor(Date.parse(scope.from) / 1000),
      endTime: Math.ceil(Date.parse(scope.to) / 1000),
      queryString: query,
      limit,
    }),
  );
  return { queryId: res.queryId, query, consoleUrl: consoleInsightsUrl(REGION, groups, query, scope.from, scope.to) };
}

async function logQueryResults(queryId: string) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(queryId)) throw new ValidationError('Invalid query ID');
  const res = await cwl.send(new GetQueryResultsCommand({ queryId }));
  const prefix = GROUP_PREFIX;
  const rows = (res.results ?? []).map((fields) => {
    const row: Record<string, string> = {};
    for (const f of fields) if (f.field && f.field !== '@ptr') row[f.field] = f.value ?? '';
    // @log is "<account>:<group name>"; show just the log type.
    if (row['@log']) {
      const group = row['@log'].slice(row['@log'].indexOf(':') + 1);
      row.logType = group.startsWith(prefix) ? group.slice(prefix.length) : group;
      delete row['@log'];
    }
    return row;
  });
  return { status: res.status, rows, stats: res.statistics };
}

// ---------- Rules ----------

async function putRule(id: string, body: unknown) {
  const rule = validateRule(id, body);
  const { id: key, ...rest } = rule;
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: { entity: 'rule', key, ...rest, updatedAt: new Date().toISOString() } }));
  return rule;
}

async function deleteRule(id: string) {
  if (!RULE_ID_RE.test(id)) throw new ValidationError('Invalid rule ID');
  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { entity: 'rule', key: id } }));
  return { deleted: id };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey; // e.g. "PUT /channels/{name}"
  try {
    if (route === 'GET /health') return json(200, { ok: true });

    const provided = event.headers?.['x-operator-key'] ?? '';
    if (!provided || !safeEqual(provided, await operatorKey())) return json(401, { error: 'Invalid or missing operator key' });

    switch (route) {
      case 'GET /channels':
        return json(200, { channels: await getChannels(), dedupWindowMinutes: await getDedupWindowMinutes() });
      case 'PUT /channels/{name}':
        return json(200, await updateChannel(event.pathParameters?.name ?? '', parseBody(event)));
      case 'PUT /settings/dedup': {
        const windowMinutes = validateDedupWindow(parseBody(event));
        await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: { entity: 'settings', key: 'dedup', windowMinutes } }));
        return json(200, { windowMinutes });
      }
      case 'GET /history':
        return json(200, { items: await history(event.queryStringParameters?.limit) });
      case 'GET /rules':
        return json(200, { rules: (await getRules()).sort((a, b) => a.name.localeCompare(b.name)), logTypes: LOG_TYPES });
      case 'PUT /rules/{id}':
        return json(200, await putRule(event.pathParameters?.id ?? '', parseBody(event)));
      case 'DELETE /rules/{id}':
        return json(200, await deleteRule(event.pathParameters?.id ?? ''));
      case 'GET /logs/hosts':
        return json(200, { hosts: await fleetHosts(), logTypes: LOG_TYPES });
      case 'POST /logs/query':
        return json(200, await startLogQuery(parseBody(event)));
      case 'GET /logs/query/{id}':
        return json(200, await logQueryResults(event.pathParameters?.id ?? ''));
      default:
        return json(404, { error: `No route ${route}` });
    }
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { error: err.message });
    // Logs Insights rejects malformed queries with InvalidParameter / MalformedQuery: surface those to the operator.
    if (err instanceof Error && /MalformedQuery|InvalidParameter/.test(err.name)) return json(400, { error: err.message });
    console.error(JSON.stringify({ msg: 'api error', route, error: String(err) }));
    return json(500, { error: 'Internal error' });
  }
};
