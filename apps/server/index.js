import express from 'express';

import { loadEnvironment } from '../../src/util/loadEnv.js';
import { loadSentry } from '../../src/util/sentryFacade.js';
import { ApifyClient } from '../../src/clients/apifyClient.js';
import { mapDatasetItemToIncident } from '../../src/lib/incidentMapper.js';
import { buildRedpandaClientFromEnv } from '../../src/util/redpandaFactory.js';

const DEFAULT_TOPIC = 'carrier-events';
const DEFAULT_LIMIT = Number(process.env.APIFY_DATASET_LIMIT ?? '50');
const DEFAULT_MIN_DELAY = Number(process.env.APIFY_MIN_DELAY_HOURS ?? '24');

async function bootstrap() {
  loadEnvironment();
  if (!process.env.APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is required for webhook ingestion.');
  }

  const Sentry = await loadSentry();
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: Number(process.env.SENTRY_TRACE_SAMPLE_RATE ?? '1'),
  });

  const app = express();
  app.use(express.json());

  const apifyClient = new ApifyClient({
    baseUrl: process.env.APIFY_BASE_URL,
    token: process.env.APIFY_TOKEN,
  });
  const redpandaClient = await buildRedpandaClientFromEnv();
  const topicName = process.env.REDPANDA_EVENTS_TOPIC ?? DEFAULT_TOPIC;
  if (!topicName) {
    console.warn(
      'REDPANDA_EVENTS_TOPIC not set; falling back to default topic:',
      DEFAULT_TOPIC,
    );
  }

  app.post('/webhook/apify', async (req, res) => {
    const transaction = Sentry.startTransaction({
      name: 'webhook.apify',
      op: 'ingest',
    });
    try {
      if (
        process.env.APIFY_HOOK_SECRET &&
        req.headers['x-hook-secret'] !== process.env.APIFY_HOOK_SECRET
      ) {
        transaction.setStatus('permission_denied');
        return res.status(401).json({ error: 'invalid webhook secret' });
      }

      const datasetId =
        req.body?.datasetId ??
        req.body?.defaultDatasetId ??
        req.body?.resource?.defaultDatasetId;
      if (!datasetId) {
        transaction.setStatus('invalid_argument');
        return res.status(400).json({ error: 'datasetId missing' });
      }

      Sentry.addBreadcrumb({
        category: 'apify',
        data: { datasetId },
        level: 'info',
        message: 'Fetching dataset items',
      });

      const items = await apifyClient.getDatasetItems(datasetId, {
        limit: DEFAULT_LIMIT,
        clean: true,
      });

      const incidents = []
        .concat(items || [])
        .map((item) =>
          mapDatasetItemToIncident(item, { minDelayHours: DEFAULT_MIN_DELAY }),
        )
        .filter(Boolean);

      if (incidents.length === 0) {
        transaction.setStatus('ok');
        return res.json({
          status: 'no_incidents',
          datasetId,
        });
      }

      const publishResults = await publishIncidents(
        redpandaClient,
        topicName,
        incidents,
      );

      transaction.setStatus('ok');
      return res.json({
        status: 'ingested',
        datasetId,
        incidents: incidents.length,
        redpanda: publishResults,
      });
    } catch (error) {
      Sentry.captureException(error);
      transaction.setStatus('internal_error');
      return res.status(500).json({ error: error.message });
    } finally {
      transaction.finish();
    }
  });

  const requestedPort = Number(process.env.SERVER_PORT ?? '3000');
  const host = process.env.SERVER_HOST ?? '127.0.0.1';

  let server;
  try {
    server = await startServer(app, host, requestedPort);
  } catch (error) {
    console.warn(`Failed to bind ${host}:${requestedPort} (${error.message}). Retrying on ephemeral port.`);
    server = await startServer(app, host, 0);
  }

  const shutdown = async () => {
    console.log('Shutting down webhook server...');
    server.close();
    if (typeof redpandaClient?.close === 'function') {
      await redpandaClient.close();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function publishIncidents(redpandaClient, topicName, incidents) {
  if (!redpandaClient?.isConfigured) {
    return { status: 'skipped', reason: 'redpanda-not-configured' };
  }

  const records = incidents.map((incident) => ({
    key: incident.orderId,
    value: {
      type: incident.type,
      payload: incident,
    },
  }));

  return redpandaClient.produce(topicName, records);
}

bootstrap().catch((error) => {
  console.error('Failed to start webhook server:', error);
  process.exitCode = 1;
});

async function startServer(app, host, port) {
  return new Promise((resolve, reject) => {
    const server = app
      .listen(port, host, () => {
        const addr = server.address();
        console.log(`Apify webhook server listening on ${addr.address}:${addr.port}`);
        resolve(server);
      })
      .on('error', (error) => reject(error));
  });
}
