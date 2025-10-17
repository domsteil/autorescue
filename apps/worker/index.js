import Ajv from 'ajv';
import { appendFile } from 'node:fs/promises';

import { loadEnvironment } from '../../src/util/loadEnv.js';
import { loadSentry } from '../../src/util/sentryFacade.js';
import { Kafka } from 'kafkajs';

import { AiriaClient } from '../../src/clients/airiaClient.js';
import { SentryClient as SentryApiClient } from '../../src/clients/sentryClient.js';
import { buildRedpandaClientFromEnv, resolveRedpandaBrokers } from '../../src/util/redpandaFactory.js';
import { DelayRescueWorkflow } from '../../src/workflows/delayRescueWorkflow.js';

const EVENTS_TOPIC = process.env.REDPANDA_EVENTS_TOPIC ?? 'carrier-events';
const ACTIONS_TOPIC = process.env.REDPANDA_ACTIONS_TOPIC ?? 'actions';
const GROUP_ID = process.env.REDPANDA_GROUP_ID ?? 'autorescue-worker';

async function bootstrap() {
  loadEnvironment();
  const simulateAiria = process.env.SIMULATE_AIRIA === '1';
  checkRequiredEnv(simulateAiria);

  const Sentry = await loadSentry();
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: Number(process.env.SENTRY_TRACE_SAMPLE_RATE ?? '1'),
  });

  const sentryApiClient = await buildSentryClient();
  const redpandaProducer = await buildRedpandaClientFromEnv();
  const decisionSchema = await loadDecisionSchema();
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateDecision = ajv.compile(decisionSchema);
  const airiaClient = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    projectId: process.env.AIRIA_PROJECT_ID,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  const decisionLogPath = process.env.DECISION_LOG_PATH;

  const workflow = new DelayRescueWorkflow({
    airiaClient,
    sentryClient: sentryApiClient,
    redpandaClient: redpandaProducer,
    deploymentId: process.env.AIRIA_DEPLOYMENT_ID,
    eventTopic: null, // avoid republishing the consumed message
    actionTopic: ACTIONS_TOPIC,
    simulate: simulateAiria,
    decisionValidator: (decision) => {
      const valid = validateDecision(decision);
      if (valid) return true;
      const errors = validateDecision.errors ?? [];
      errors.forEach((error) => {
        Sentry.addBreadcrumb({
          category: 'decision-validation',
          level: 'error',
          data: error,
        });
      });
      return errors.map((error) => `${error.instancePath || '/'} ${error.message}`);
    },
  });

  const kafka = buildKafka();
  const consumer = kafka.consumer({ groupId: GROUP_ID });

  const admin = kafka.admin();
  await consumer.connect();
  if (process.env.AUTO_CREATE_TOPICS === '1') {
    await ensureTopicsExist(admin, [EVENTS_TOPIC, ACTIONS_TOPIC].filter(Boolean));
  }
  await consumer.subscribe({
    topic: EVENTS_TOPIC,
    fromBeginning: false,
  });
  if (process.env.REDPANDA_ACTIONS_TOPIC) {
    const producerTopic = process.env.REDPANDA_ACTIONS_TOPIC;
    console.log(`Will publish actions to ${producerTopic}`);
  }

  console.log(`Worker subscribed to ${EVENTS_TOPIC} (group ${GROUP_ID})`);

  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      const transaction = Sentry.startTransaction({
        name: 'autorescue.worker',
        op: 'consume',
      });
      try {
        const payload = message.value?.toString();
        if (!payload) {
          Sentry.addBreadcrumb({
            category: 'worker',
            level: 'warning',
            message: 'Empty payload skipped',
            data: { partition, offset: message.offset },
          });
          return;
        }

        const envelope = JSON.parse(payload);
        const incident =
          envelope?.payload && envelope?.type
            ? envelope.payload
            : envelope;

        Sentry.addBreadcrumb({
          category: 'incident',
          data: {
            incidentId: incident?.incidentId,
            orderId: incident?.orderId,
            type: incident?.type,
          },
          level: 'info',
        });

        const runResult = await workflow.run(incident);
        await logDecision(decisionLogPath, runResult);
        transaction.setStatus('ok');
      } catch (error) {
        Sentry.captureException(error);
        transaction.setStatus('internal_error');
      } finally {
        transaction.finish();
      }
    },
  });

  const shutdown = async () => {
    console.log('Shutting down worker...');
    await consumer.disconnect();
    try {
      await admin.disconnect();
    } catch (err) {
      // ignore
    }
    if (typeof redpandaProducer?.close === 'function') {
      await redpandaProducer.close();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function checkRequiredEnv(simulate) {
  const required = [
    'AIRIA_API_KEY',
    'AIRIA_DEPLOYMENT_ID',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (simulate) {
    const filtered = missing.filter((key) => key !== 'AIRIA_DEPLOYMENT_ID');
    if (filtered.length === 0) {
      return;
    }
    throw new Error(`Missing required environment variables: ${filtered.join(', ')}`);
  }
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

async function buildSentryClient() {
  if (!process.env.SENTRY_TOKEN) {
    return null;
  }
  try {
    const client = new SentryApiClient({
      token: process.env.SENTRY_TOKEN,
      baseUrl: process.env.SENTRY_BASE_URL,
      organizationSlug: process.env.SENTRY_ORG_SLUG,
      projectSlug: process.env.SENTRY_PROJECT_SLUG,
    });
    await client.ensureOrganizationSlug();
    await client.ensureProjectSlug();
    return client;
  } catch (error) {
    console.warn('Unable to initialize Sentry API client:', error.message);
    return null;
  }
}


async function ensureTopicsExist(admin, topics) {
  if (!topics.length) return;
  try {
    await admin.connect();
    const existing = await admin.listTopics();
    const missing = topics.filter((topic) => topic && !existing.includes(topic));
    if (missing.length === 0) return;
    console.log(`Ensuring topics exist: ${missing.join(', ')}`);
    await admin.createTopics({
      topics: missing.map((topic) => ({
        topic,
        numPartitions: Number(process.env.REDPANDA_DEFAULT_PARTITIONS ?? '1'),
        replicationFactor: Number(process.env.REDPANDA_DEFAULT_REPLICATION ?? '-1'),
      })),
    });
  } catch (error) {
    console.warn(`Topic ensure failed (${error.message}). Grant appropriate permissions.`);
  } finally {
    try {
      await admin.disconnect();
    } catch (err) {
      // ignore
    }
  }
}

function buildKafka() {
  const brokers = resolveRedpandaBrokers(process.env);
  if (!brokers || brokers.length === 0) {
    throw new Error(
      'Configure REDPANDA_BROKERS or REDPANDA_CLUSTER_ID/REDPANDA_REGION for Kafka connectivity.',
    );
  }

  const brokerList = Array.isArray(brokers) ? brokers : brokers.split(',');
  const sslOptions = { rejectUnauthorized: false };
  if (process.env.REDPANDA_CA_CERT) {
    sslOptions.ca = [process.env.REDPANDA_CA_CERT];
  }
  if (process.env.REDPANDA_CLIENT_CERT && process.env.REDPANDA_CLIENT_KEY) {
    sslOptions.cert = process.env.REDPANDA_CLIENT_CERT;
    sslOptions.key = process.env.REDPANDA_CLIENT_KEY;
  }

  return new Kafka({
    clientId: process.env.REDPANDA_CLIENT_ID ?? 'autorescue-worker',
    brokers: brokerList,
    ssl: sslOptions,
    sasl: {
      mechanism:
        process.env.KAFKA_SASL_MECHANISM ??
        process.env.REDPANDA_MECHANISM ??
        'scram-sha-256',
      username:
        process.env.KAFKA_USERNAME ?? process.env.REDPANDA_USERNAME,
      password:
        process.env.KAFKA_PASSWORD ?? process.env.REDPANDA_PASSWORD,
    },
  });
}

bootstrap().catch((error) => {
  if (error && error.type === 'TOPIC_AUTHORIZATION_FAILED') {
    console.error('Topic authorization failed. Ensure your Redpanda credentials have read access to', EVENTS_TOPIC, 'and write access to', ACTIONS_TOPIC);
  } else {
    console.error('Failed to start worker:', error);
  }
  process.exitCode = 1;
});

async function loadDecisionSchema() {
  const fs = await import('node:fs/promises');
  const url = new URL('../../config/decision.schema.json', import.meta.url);
  const contents = await fs.readFile(url, "utf-8");
  return JSON.parse(contents);
}

async function logDecision(path, payload) {
  if (!path) return;
  try {
    const line = JSON.stringify(payload) + '\n';
    await appendFile(path, line, { encoding: 'utf-8' });
  } catch (error) {
    console.warn(`Failed to append decision log: ${error.message}`);
  }
}
