#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvironment } from '../src/util/loadEnv.js';
import { DelayRescueWorkflow } from '../src/workflows/delayRescueWorkflow.js';
import { AiriaClient } from '../src/clients/airiaClient.js';
import { buildRedpandaClientFromEnv } from '../src/util/redpandaFactory.js';
import { ApifyClient } from '../src/clients/apifyClient.js';
import { mapDatasetItemToIncident } from '../src/lib/incidentMapper.js';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const DEFAULT_EVENT_PATH = 'data/events/sample-delay-event.json';
const DEFAULT_APIFY_INPUT_PATH = 'python/sample_apify_input.json';

async function main() {
  loadEnvironment();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showUsage();
    return;
  }

  const env = process.env;

  const apifyConfig = buildApifyConfig(env);
  const useApify = Boolean(
    env.APIFY_TOKEN && (apifyConfig.datasetId || apifyConfig.actorId),
  );

  if (options.live && !useApify) {
    throw new Error(
      '--live requires APIFY_TOKEN and either APIFY_DATASET_ID or APIFY_ACTOR_ID.',
    );
  }

  let apifyUsed = useApify;
  let incidentData;
  if (useApify) {
    try {
      incidentData = await fetchIncidentFromApify(apifyConfig);
    } catch (error) {
      if (options.live) {
        throw error;
      }
      console.warn(
        `Apify integration failed (${error.message}); falling back to sample incident.`,
      );
      incidentData = await loadSampleIncident();
      apifyUsed = false;
    }
  } else {
    incidentData = await loadSampleIncident();
  }

  const {
    incident,
    source: incidentSource,
    apifyMeta,
  } = incidentData;
  const preferSimulation = useApify && !apifyUsed;

  logSection('Apify intake');
  if (apifyUsed) {
    console.log(
      `Mode: live (dataset ${apifyMeta.datasetId}${
        apifyMeta.runId ? ` from run ${apifyMeta.runId}` : ''
      })`,
    );
    console.log(
      `Selected item ${apifyMeta.selectedIndex + 1} of ${
        apifyMeta.itemCount
      } (delay ≥ ${apifyConfig.minDelayHours}h)`,
    );
  } else {
    console.log(
      `Mode: simulation (using ${relativePath(DEFAULT_EVENT_PATH)})`,
    );
  }
  console.log(`Incident: ${incident.incidentId} for order ${incident.orderId}`);
  console.log('');

  const airiaClient = new AiriaClient({
    baseUrl: env.AIRIA_BASE_URL,
    apiKey: env.AIRIA_API_KEY,
    projectId: env.AIRIA_PROJECT_ID,
    correlationId: env.AIRIA_CORRELATION_ID,
  });

  let simulateAiria = resolveAiriaSimulation(options.live, env, airiaClient);
  if (!options.live && preferSimulation && !simulateAiria) {
    console.warn(
      'Airia live mode disabled; using simulation because Apify was unreachable.',
    );
    simulateAiria = true;
  }
  if (!simulateAiria) {
    if (!airiaClient.isConfigured || !env.AIRIA_DEPLOYMENT_ID) {
      if (options.live) {
        throw new Error(
          '--live requires AIRIA_API_KEY and AIRIA_DEPLOYMENT_ID for live agent execution.',
        );
      }
      console.warn(
        'Airia credentials missing; switching to simulation mode.',
      );
      simulateAiria = true;
    }
  }
  process.env.SIMULATE_AIRIA = simulateAiria ? '1' : '0';

  const eventTopic = env.REDPANDA_EVENTS_TOPIC ?? 'carrier-events';
  const actionTopic = env.REDPANDA_ACTIONS_TOPIC ?? 'autorescue-actions';
  process.env.REDPANDA_EVENTS_TOPIC = eventTopic;
  process.env.REDPANDA_ACTIONS_TOPIC = actionTopic;

  let simulateRedpanda = resolveRedpandaSimulation(options.live, env);
  if (!options.live && preferSimulation && !simulateRedpanda) {
    console.warn(
      'Redpanda live producer disabled; using outbox simulation because Apify was unreachable.',
    );
    simulateRedpanda = true;
  }
  process.env.SIMULATE_REDPANDA = simulateRedpanda ? '1' : '0';

  let redpandaClient;
  let result;
  let durationMs;
  try {
    redpandaClient = await buildRedpandaClientFromEnv();
    if (!simulateRedpanda && !redpandaClient?.isConfigured) {
      if (options.live) {
        throw new Error(
          '--live expected an initialized Redpanda client. Check configuration.',
        );
      }
      console.warn(
        'Redpanda configuration missing; switching to outbox simulation.',
      );
      simulateRedpanda = true;
      process.env.SIMULATE_REDPANDA = '1';
      redpandaClient = await buildRedpandaClientFromEnv();
    }

    const workflow = new DelayRescueWorkflow({
      airiaClient,
      simulate: simulateAiria,
      deploymentId: env.AIRIA_DEPLOYMENT_ID,
      redpandaClient,
      eventTopic,
      actionTopic,
    });

    const startedAt = Date.now();
    try {
      result = await workflow.run(incident);
    } catch (error) {
      if (options.live) {
        throw error;
      }
      if (!simulateAiria) {
        console.warn(
          `Airia call failed (${error.message}); retrying with simulation data.`,
        );
        simulateAiria = true;
        process.env.SIMULATE_AIRIA = '1';
        const fallbackWorkflow = new DelayRescueWorkflow({
          airiaClient,
          simulate: true,
          deploymentId: env.AIRIA_DEPLOYMENT_ID,
          redpandaClient,
          eventTopic,
          actionTopic,
        });
        result = await fallbackWorkflow.run(incident);
      } else {
        throw error;
      }
    }
    durationMs = Date.now() - startedAt;
  } finally {
    if (typeof redpandaClient?.close === 'function') {
      await redpandaClient.close();
    }
  }

  logSection('Airia decision');
  console.log(
    `Mode: ${
      simulateAiria
        ? `simulation (${relativePath('data/simulations/airia-decision.json')})`
        : 'live agent execution'
    }`,
  );
  console.log(
    `Tool call: ${result?.decision?.toolCall?.name ?? 'manual_review'}`,
  );
  console.log(
    `Policy approved: ${
      result?.policyReview?.allowed === false ? 'no' : 'yes'
    }`,
  );
  if (result?.decision?.customerMessage) {
    console.log(`Customer message: ${result.decision.customerMessage}`);
  }
  console.log('');

  logSection('Redpanda delivery');
  console.log(
    `Mode: ${simulateRedpanda ? 'outbox simulation' : 'live producer'}`,
  );
  console.log(
    `Event topic ${eventTopic}: ${
      result?.redpandaStatus?.event?.status ?? 'n/a'
    }`,
  );
  console.log(
    `Action topic ${actionTopic}: ${
      result?.redpandaStatus?.action?.status ?? 'n/a'
    }`,
  );
  if (simulateRedpanda) {
    printOutboxPaths(eventTopic, actionTopic);
  }
  console.log('');

  logSection('Demo summary');
  console.log(`Duration: ${durationMs} ms`);
  console.log(`Incident source: ${incidentSource}`);
  console.log(`Action plan: ${result?.actionPlan?.summary ?? 'n/a'}`);
  if (Array.isArray(result?.nextSteps) && result.nextSteps.length > 0) {
    console.log('Next steps:');
    result.nextSteps.forEach((step, index) => {
      console.log(`  ${index + 1}. ${step.description} (${step.owner})`);
    });
  }
  if (options.raw) {
    console.log('');
    console.log(JSON.stringify(result, null, 2));
  }
}

function parseArgs(argv) {
  const options = {
    live: false,
    raw: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--live':
        options.live = true;
        break;
      case '--raw':
      case '--json':
        options.raw = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function showUsage() {
  console.log('AutoRescue Apify → Airia → Redpanda demo');
  console.log('Usage: node scripts/apify-airia-redpanda-demo.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --live           Require live integrations (fail if credentials missing).');
  console.log('  --raw | --json   Print the full workflow result payload.');
  console.log('  --help, -h       Show this message.');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/apify-airia-redpanda-demo.js');
  console.log('  node scripts/apify-airia-redpanda-demo.js --raw');
  console.log('  node scripts/apify-airia-redpanda-demo.js --live');
}

function buildApifyConfig(env) {
  return {
    datasetId: env.APIFY_DATASET_ID ?? null,
    actorId: env.APIFY_ACTOR_ID ?? null,
    inputPath: env.APIFY_INPUT_PATH ?? null,
    waitForFinish: toNumber(env.APIFY_WAIT_FOR_FINISH, 60),
    limit: toNumber(env.APIFY_DATASET_LIMIT, 25),
    minDelayHours: toNumber(env.APIFY_MIN_DELAY_HOURS, 24),
  };
}

async function fetchIncidentFromApify({
  datasetId,
  actorId,
  inputPath,
  waitForFinish,
  limit,
  minDelayHours,
}) {
  const token = process.env.APIFY_TOKEN;
  const client = new ApifyClient({
    baseUrl: process.env.APIFY_BASE_URL,
    token,
  });

  let items;
  let resolvedDatasetId = datasetId ?? null;
  let runId = null;

  if (datasetId) {
    items = await client.getDatasetItems(datasetId, {
      limit,
      clean: true,
    });
  } else {
    if (!actorId) {
      throw new Error(
        'APIFY_ACTOR_ID is required when APIFY_DATASET_ID is not provided.',
      );
    }

    const inputPayload = await resolveApifyInput(inputPath);

    const runMeta = await client.runActor(actorId, {
      input: inputPayload,
      timeout: Number(process.env.APIFY_TIMEOUT ?? '120'),
      memory: Number(process.env.APIFY_MEMORY ?? '1024'),
      build: process.env.APIFY_BUILD,
      maxItems: limit,
    });

    runId = runMeta?.id ?? null;
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

    resolvedDatasetId =
      run.defaultDatasetId ??
      run.defaultDataset?.id ??
      runMeta.defaultDatasetId ??
      resolvedDatasetId;
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

  const selection = selectIncidentFromItems(items, { minDelayHours });
  if (!selection.incident) {
    throw new Error(
      `No dataset items met delay threshold (${minDelayHours} hours).`,
    );
  }

  const source = resolvedDatasetId
    ? `apify-dataset:${resolvedDatasetId}`
    : `apify-actor:${actorId}`;

  return {
    incident: selection.incident,
    source,
    apifyMeta: {
      datasetId: resolvedDatasetId,
      runId,
      actorId,
      itemCount: items.length,
      selectedIndex: selection.index,
    },
  };
}

async function loadSampleIncident(pathLike = DEFAULT_EVENT_PATH) {
  const incident = await loadJson(pathLike);
  return {
    incident,
    source: `file:${relativePath(pathLike)}`,
    apifyMeta: null,
  };
}

function resolveAiriaSimulation(forceLive, env, airiaClient) {
  if (forceLive) {
    if (env.SIMULATE_AIRIA === '1') {
      console.warn('Ignoring SIMULATE_AIRIA=1 because --live requested.');
    }
    return false;
  }
  if (env.SIMULATE_AIRIA === '1') return true;
  if (env.SIMULATE_AIRIA === '0') return false;
  return !(airiaClient.isConfigured && env.AIRIA_DEPLOYMENT_ID);
}

function resolveRedpandaSimulation(forceLive, env) {
  if (forceLive) {
    if (env.SIMULATE_REDPANDA === '1') {
      console.warn('Ignoring SIMULATE_REDPANDA=1 because --live requested.');
    }
    return false;
  }
  if (env.SIMULATE_REDPANDA === '1') return true;
  if (env.SIMULATE_REDPANDA === '0') {
    if (!hasRedpandaConfig(env)) {
      console.warn(
        'SIMULATE_REDPANDA=0 but configuration missing; falling back to outbox mode.',
      );
      return true;
    }
    return false;
  }
  return !hasRedpandaConfig(env);
}

function hasRedpandaConfig(env) {
  if (env.REDPANDA_HTTP_BASE_URL) return true;
  if (env.REDPANDA_BROKERS) {
    const brokers = env.REDPANDA_BROKERS.split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    if (brokers.length > 0) {
      return true;
    }
  }
  if (env.REDPANDA_CLUSTER_ID) return true;
  return false;
}

function printOutboxPaths(eventTopic, actionTopic) {
  const outboxDir = process.env.OUTBOX_DIR ?? 'outbox';
  const eventFile = resolveOutboxPath(outboxDir, eventTopic);
  const actionFile = resolveOutboxPath(outboxDir, actionTopic);
  console.log('Outbox files:');
  if (eventFile) {
    console.log(`  ${eventFile}`);
  }
  if (actionFile) {
    console.log(`  ${actionFile}`);
  }
}

function resolveOutboxPath(outboxDir, topic) {
  if (!topic) return null;
  const absolute = resolve(repoRoot, outboxDir, `${topic}.jsonl`);
  return relative(repoRoot, absolute);
}

function selectIncidentFromItems(items, { minDelayHours = 24 } = {}) {
  for (let index = 0; index < items.length; index += 1) {
    const incident = mapDatasetItemToIncident(items[index], { minDelayHours });
    if (incident) {
      return { incident, index };
    }
  }
  return { incident: null, index: -1 };
}

async function resolveApifyInput(inputPath) {
  if (inputPath) {
    return loadJson(inputPath);
  }
  if (process.env.APIFY_INPUT_PATH) {
    return loadJson(process.env.APIFY_INPUT_PATH);
  }
  if (process.env.APIFY_INPUT_JSON) {
    return JSON.parse(process.env.APIFY_INPUT_JSON);
  }
  try {
    return await loadJson(DEFAULT_APIFY_INPUT_PATH);
  } catch (error) {
    console.warn(
      `Apify actor input not provided and sample payload ${relativePath(
        DEFAULT_APIFY_INPUT_PATH,
      )} could not be loaded (${error.message}).`,
    );
    return undefined;
  }
}

async function loadJson(pathLike) {
  const absolute = resolvePath(pathLike);
  const raw = await readFile(absolute, 'utf-8');
  return JSON.parse(raw);
}

function resolvePath(input) {
  if (!input) {
    throw new Error('Path is required.');
  }
  if (input.startsWith('file://')) {
    return fileURLToPath(new URL(input));
  }
  if (input.startsWith('/')) {
    return input;
  }
  return resolve(repoRoot, input);
}

function relativePath(pathLike) {
  const absolute = resolvePath(pathLike);
  return relative(repoRoot, absolute);
}

function toNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function logSection(title) {
  console.log(`=== ${title} ===`);
}

main().catch((error) => {
  console.error('Demo execution failed:', error);
  process.exitCode = 1;
});
