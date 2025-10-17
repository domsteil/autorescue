import { RedpandaClient } from '../clients/redpandaClient.js';
import { createRedpandaKafkaClient } from '../clients/redpandaKafkaClient.js';
import { sanitizeForReport } from './objectSanitizer.js';
import { persistOutboxRecord } from './outbox.js';

export async function buildRedpandaClientFromEnv(env = process.env) {
  if (env.SIMULATE_REDPANDA === '1') {
    return new OutboxOnlyRedpandaClient(env.OUTBOX_DIR);
  }

  const clients = [];

  const httpClient = buildRedpandaHttpClient(env);
  if (httpClient) clients.push(httpClient);

  const kafkaClient = await buildRedpandaKafkaClient(env);
  if (kafkaClient) clients.push(kafkaClient);

  if (clients.length === 0) {
    return null;
  }

  if (clients.length === 1) {
    return clients[0];
  }

  return new CompositeRedpandaClient(clients);
}

function buildRedpandaHttpClient(env) {
  const baseUrl = env.REDPANDA_HTTP_BASE_URL;
  if (!baseUrl) return null;

  try {
    return new RedpandaClient({
      baseUrl,
      apiKey: env.REDPANDA_API_KEY ?? env.REDPANDA_TOKEN,
      authorizationHeader: env.REDPANDA_AUTH_HEADER ?? 'Authorization',
      authorizationScheme: env.REDPANDA_AUTH_SCHEME ?? 'Bearer',
      staticHeaders: parseStaticHeaders(env.REDPANDA_STATIC_HEADERS),
    });
  } catch (error) {
    console.warn(
      'Redpanda HTTP client disabled due to configuration error:',
      error.message,
    );
    return null;
  }
}

async function buildRedpandaKafkaClient(env) {
  const brokers = resolveRedpandaBrokers(env);
  if (brokers.length === 0) return null;

  try {
    const kafkaModule = await import('kafkajs');
    return createRedpandaKafkaClient(kafkaModule, {
      brokers,
      username: env.REDPANDA_USERNAME ?? env.REDPANDA_API_KEY,
      password: env.REDPANDA_PASSWORD ?? env.REDPANDA_TOKEN,
      mechanism: env.REDPANDA_MECHANISM ?? 'SCRAM-SHA-256',
      clientId: env.REDPANDA_CLIENT_ID ?? 'autorescue-workflow',
    });
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn(
        'kafkajs module not found. Install it or set REDPANDA_HTTP_BASE_URL to use the HTTP proxy.',
      );
      return null;
    }
    console.warn(
      'Redpanda Kafka client disabled due to configuration error:',
      error.message,
    );
    return null;
  }
}

function resolveRedpandaBrokers(env) {
  const brokersEnv = env.REDPANDA_BROKERS;
  if (brokersEnv) {
    return brokersEnv
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
  }

  const clusterId = env.REDPANDA_CLUSTER_ID;
  if (!clusterId) return [];
  const region = env.REDPANDA_REGION ?? extractRegionFromHttpBase(env.REDPANDA_HTTP_BASE_URL);

  if (environmentWantsServerless(env)) {
    const resolvedRegion = region ?? 'us-west-2';
    if (!region) {
      console.warn('REDPANDA_REGION not provided; defaulting to us-west-2 for serverless broker.');
    }
    const domain = `${clusterId}.any.${resolvedRegion}.mpx.prd.cloud.redpanda.com`;
    return [`${domain}:9092`];
  }

  const domain = region
    ? `${clusterId}.kafka.${region}.serverless.prd.cloud.redpanda.com`
    : `${clusterId}.kafka.serverless.prd.cloud.redpanda.com`;
  return [`${domain}:9092`];
}

function environmentWantsServerless(env) {
  if (env.REDPANDA_SERVERLESS === '0') return false;
  if (env.REDPANDA_SERVERLESS === '1') return true;
  return Boolean(env.REDPANDA_HTTP_BASE_URL);
}

function extractRegionFromHttpBase(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const match = host.match(/\.([a-z0-9-]+)\.mpx\.prd\.cloud\.redpanda\.com$/i);
    if (match) {
      return match[1];
    }
  } catch (error) {
    // ignore
  }
  return null;
}

function parseStaticHeaders(rawValue) {
  if (!rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.warn('Unable to parse REDPANDA_STATIC_HEADERS, ignoring:', error);
  }
  return {};
}

export class CompositeRedpandaClient {
  constructor(clients) {
    this.clients = clients;
  }

  get isConfigured() {
    return this.clients.some((client) => client?.isConfigured);
  }

  async produce(topic, records) {
    const successes = [];
    const failures = [];
    for (const client of this.clients) {
      if (!client?.isConfigured) continue;
      try {
        const result = await client.produce(topic, records);
        successes.push({
          client: client.constructor?.name ?? 'RedpandaClient',
          result: sanitizeForReport(result),
        });
      } catch (error) {
        failures.push({
          client: client.constructor?.name ?? 'RedpandaClient',
          error: error.message,
        });
      }
    }

    if (successes.length === 0 && failures.length > 0) {
      const message = failures.map((item) => item.error).join('; ');
      throw new Error(`All Redpanda producers failed: ${message}`);
    }

    return { successes, failures };
  }

  async close() {
    for (const client of this.clients) {
      if (typeof client?.close === 'function') {
        try {
          await client.close();
        } catch (error) {
          console.warn('Error closing Redpanda producer:', error.message);
        }
      }
    }
  }
}

export { resolveRedpandaBrokers };

class OutboxOnlyRedpandaClient {
  constructor(dir) {
    this.dir = dir;
  }

  get isConfigured() {
    return true;
  }

  async produce(topic, records) {
    for (const record of records) {
      await persistOutboxRecord(topic, {
        key: record.key ?? null,
        value: record.value,
        simulated: true,
      });
    }
    return {
      successes: [{ client: 'OutboxOnlyRedpandaClient', result: { count: records.length } }],
      failures: [],
    };
  }

  async close() {}
}
