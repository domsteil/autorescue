import { readFile, writeFile } from 'node:fs/promises';
import { AiriaClient } from './clients/airiaClient.js';
import { RedpandaClient } from './clients/redpandaClient.js';
import { createRedpandaKafkaClient } from './clients/redpandaKafkaClient.js';
import { SentryClient } from './clients/sentryClient.js';
import { ApifyClient } from './clients/apifyClient.js';
import { buildRedpandaClientFromEnv } from './util/redpandaFactory.js';
import { mapDatasetItemToIncident } from './lib/incidentMapper.js';
import { loadEnvironment } from './util/loadEnv.js';
import { sanitizeForReport } from './util/objectSanitizer.js';
import { DelayRescueWorkflow } from './workflows/delayRescueWorkflow.js';

async function loadEvent(pathLike) {
  if (!pathLike) {
    throw new Error('Event path is required.');
  }
  let data;
  if (pathLike.startsWith('file://')) {
    data = await readFile(new URL(pathLike), 'utf-8');
  } else if (pathLike.startsWith('/')) {
    data = await readFile(pathLike, 'utf-8');
  } else {
    data = await readFile(new URL(pathLike, import.meta.url), 'utf-8');
  }
  return JSON.parse(data);
}

loadEnvironment();

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  const useApify =
    cli.useApify || process.env.APIFY_USE_ACTOR === '1' || !cli.eventPath;

  const event = useApify
    ? await loadEventFromApify({
        datasetId: cli.apifyDatasetId ?? process.env.APIFY_DATASET_ID,
        actorId: process.env.APIFY_ACTOR_ID,
        inputPath: cli.apifyInputPath ?? process.env.APIFY_INPUT_PATH,
        waitForFinish: Number(process.env.APIFY_WAIT_FOR_FINISH ?? '60'),
        limit: Number(process.env.APIFY_DATASET_LIMIT ?? '25'),
        minDelayHours: Number(process.env.APIFY_MIN_DELAY_HOURS ?? '24'),
      })
    : await loadEvent(cli.eventPath);

  const airiaClient = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    projectId: process.env.AIRIA_PROJECT_ID,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  const redpandaClient = await buildRedpandaClientFromEnv();
  const sentryClient = await buildSentryClient();

  const simulate =
    process.env.SIMULATE_AIRIA === '1' || !airiaClient.isConfigured;

  const workflow = new DelayRescueWorkflow({
    airiaClient,
    simulate,
    deploymentId: process.env.AIRIA_DEPLOYMENT_ID,
    redpandaClient,
    eventTopic: process.env.REDPANDA_EVENTS_TOPIC,
    actionTopic: process.env.REDPANDA_ACTIONS_TOPIC,
    sentryClient,
  });

  try {
    const result = await workflow.run(event);
    console.log(JSON.stringify(result, null, 2));
    if (cli.summary) {
      const summary = buildRunSummary(result);
      console.error('Run Summary:');
      console.error(JSON.stringify(summary, null, 2));
    }
    if (cli.outputPath) {
      await writeOutput(cli.outputPath, result);
    }
  } finally {
    if (typeof redpandaClient?.close === 'function') {
      await redpandaClient.close();
    }
  }
}

async function buildSentryClient() {
  const token = process.env.SENTRY_TOKEN;
  if (!token) return null;

  try {
    const client = new SentryClient({
      token,
      baseUrl: process.env.SENTRY_BASE_URL,
      organizationSlug: process.env.SENTRY_ORG_SLUG,
      projectSlug: process.env.SENTRY_PROJECT_SLUG,
    });
    await client.ensureOrganizationSlug();
    await client.ensureProjectSlug();
    return client;
  } catch (error) {
    console.warn(
      'Sentry client disabled due to configuration error:',
      error.message,
    );
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    eventPath: null,
    useApify: false,
    apifyDatasetId: null,
    apifyInputPath: null,
    outputPath: null,
    summary: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--event':
        options.eventPath = argv[i + 1];
        i += 1;
        break;
      case '--apify':
        options.useApify = true;
        break;
      case '--apify-dataset':
        options.apifyDatasetId = argv[i + 1];
        i += 1;
        break;
      case '--apify-input':
        options.apifyInputPath = argv[i + 1];
        i += 1;
        break;
      case '--output':
        options.outputPath = argv[i + 1];
        i += 1;
        break;
      case '--summary':
        options.summary = true;
        break;
      default:
        if (!options.eventPath) {
          options.eventPath = arg;
        }
        break;
    }
  }

  if (!options.eventPath && !options.useApify) {
    options.eventPath = '../data/events/sample-delay-event.json';
  }

  return options;
}

async function loadEventFromApify({
  datasetId,
  actorId,
  inputPath,
  waitForFinish = 60,
  limit = 25,
  minDelayHours = 24,
}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error(
      'APIFY_TOKEN is required when sourcing incidents from Apify.',
    );
  }

  const client = new ApifyClient({
    baseUrl: process.env.APIFY_BASE_URL,
    token,
  });

  let items;
  let runMeta;

  if (datasetId) {
    items = await client.getDatasetItems(datasetId, {
      limit,
      clean: true,
    });
  } else {
    if (!actorId) {
      throw new Error(
        'Set APIFY_ACTOR_ID or provide --apify-dataset when using the Apify integration.',
      );
    }

    let inputPayload;
    if (inputPath) {
      inputPayload = await loadEvent(inputPath);
    } else if (process.env.APIFY_INPUT_JSON) {
      inputPayload = JSON.parse(process.env.APIFY_INPUT_JSON);
    }

    try {
      runMeta = await client.runActor(actorId, {
        input: inputPayload,
        timeout: Number(process.env.APIFY_TIMEOUT ?? '120'),
        memory: Number(process.env.APIFY_MEMORY ?? '1024'),
        build: process.env.APIFY_BUILD,
        maxItems: limit,
      });
    } catch (error) {
      if (error.message.includes('unknown-build-tag')) {
        throw new Error(
          `Apify actor build \"${process.env.APIFY_BUILD ?? 'latest'}\" not found. Build the actor or remove APIFY_BUILD.`,
        );
      }
      throw error;
    }

    const runId = runMeta?.id;
    if (!runId) {
      throw new Error('Apify actor run response missing run id.');
    }

    const run = await client.getRun(runId, { waitForFinish });
    const successStates = new Set([
      'SUCCEEDED',
      'SUCCEEDED_WITHOUT_CUSTOMER_ERRORS',
    ]);
    if (!successStates.has(run.status)) {
      throw new Error(
        `Apify actor run ${runId} ended with status ${run.status}.`,
      );
    }

    const resolvedDatasetId =
      run.defaultDatasetId ?? run.defaultDataset?.id ?? runMeta.defaultDatasetId;
    if (!resolvedDatasetId) {
      throw new Error(
        `Apify actor run ${runId} did not publish a default dataset.`,
      );
    }

    items = await client.getDatasetItems(resolvedDatasetId, {
      limit,
      clean: true,
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Apify dataset returned no items.');
  }

  const incident = selectIncidentFromItems(items, {
    minDelayHours,
  });

  if (!incident) {
    throw new Error(
      `No dataset items met delay threshold (${minDelayHours} hours).`,
    );
  }

  incident.source = incident.source ?? 'apify-actor';
  return incident;
}

function selectIncidentFromItems(items, { minDelayHours = 24 } = {}) {
  for (const item of items) {
    const incident = mapDatasetItemToIncident(item, { minDelayHours });
    if (incident) return incident;
  }
  return null;
}

async function writeOutput(targetPath, payload) {
  let outputUrl;
  if (targetPath.startsWith('file://')) {
    outputUrl = new URL(targetPath);
  } else if (targetPath.startsWith('/')) {
    outputUrl = targetPath;
  } else {
    outputUrl = new URL(targetPath, import.meta.url);
  }
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(outputUrl, json, 'utf-8');
}

function buildRunSummary(result) {
  return {
    incidentId: result?.incident?.incidentId,
    orderId: result?.incident?.orderId,
    decision: result?.decision?.toolCall?.name ?? 'manual_review',
    policyProof: result?.actionPlan?.policyProof ?? null,
    actionType: result?.actionPlan?.type,
    redpanda: {
      event: result?.redpandaStatus?.event?.status,
      action: result?.redpandaStatus?.action?.status,
    },
    sentry: result?.sentry?.status,
    policy: {
      allowed: result?.policyReview?.allowed,
      reasons: result?.policyReview?.reasons,
    },
  };
}

main().catch((error) => {
  console.error('AutoRescue workflow failed:', error);
  process.exitCode = 1;
});
