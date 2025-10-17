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
import { SentryClient } from '../src/clients/sentryClient.js';

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
  if (options.demo && options.live) {
    throw new Error('Use either --demo or --live, not both.');
  }

  const env = process.env;

  const airiaClient = new AiriaClient({
    baseUrl: env.AIRIA_BASE_URL,
    apiKey: env.AIRIA_API_KEY,
    projectId: env.AIRIA_PROJECT_ID,
    correlationId: env.AIRIA_CORRELATION_ID,
  });

  const simulateAiria = resolveAiriaMode({ options, env, airiaClient });
  const simulateRedpanda = resolveRedpandaMode({ options, env });

  env.SIMULATE_AIRIA = simulateAiria ? '1' : '0';
  env.SIMULATE_REDPANDA = simulateRedpanda ? '1' : '0';

  const apifyConfig = resolveApifyConfig(options, env);
  const useApify = shouldUseApify({ options, apifyConfig });
  const sentrySetup = await buildSentryClientFromEnv(env);

  if (options.live) {
    assertLiveRequirements({
      simulateAiria,
      simulateRedpanda,
      useApify,
      airiaClient,
      apifyConfig,
      sentrySetup,
      env,
    });
  }

  const { incident, apifyMeta, incidentSource } = await loadIncident({
    options,
    apifyConfig,
    useApify,
  });

  const eventTopic = env.REDPANDA_EVENTS_TOPIC ?? 'carrier-events';
  const actionTopic = env.REDPANDA_ACTIONS_TOPIC ?? 'autorescue-actions';

  env.REDPANDA_EVENTS_TOPIC = eventTopic;
  env.REDPANDA_ACTIONS_TOPIC = actionTopic;

  let redpandaClient;
  try {
    redpandaClient = await buildRedpandaClientFromEnv();
    if (!simulateRedpanda && !redpandaClient?.isConfigured) {
      throw new Error('Redpanda client failed to initialize for live run.');
    }
    if (!simulateAiria && !airiaClient.isConfigured) {
      throw new Error('AIRIA_API_KEY required for live Airia execution.');
    }

    const workflow = new DelayRescueWorkflow({
      airiaClient,
      simulate: simulateAiria,
      deploymentId: env.AIRIA_DEPLOYMENT_ID,
      redpandaClient,
      eventTopic,
      actionTopic,
      sentryClient: sentrySetup.client,
    });

    const start = Date.now();
    const result = await workflow.run(incident);
    const durationMs = Date.now() - start;

    renderSummary({
      incident,
      incidentSource,
      result,
      durationMs,
      simulateAiria,
      simulateRedpanda,
      eventTopic,
      actionTopic,
      options,
      apifyMeta,
      sentrySetup,
    });

    if (options.raw) {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    if (typeof redpandaClient?.close === 'function') {
      await redpandaClient.close();
    }
  }
}

function parseArgs(argv) {
  const options = {
    eventPath: DEFAULT_EVENT_PATH,
    live: false,
    demo: false,
    raw: false,
    help: false,
    useApify: false,
    apifyDatasetId: null,
    apifyActorId: null,
    apifyInputPath: null,
    apifyWait: null,
    apifyLimit: null,
    minDelayHours: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--event':
      case '-e':
        if (i + 1 >= argv.length) {
          throw new Error('--event requires a path argument.');
        }
        options.eventPath = argv[i + 1];
        i += 1;
        break;
      case '--live':
        options.live = true;
        break;
      case '--demo':
        options.demo = true;
        break;
      case '--raw':
      case '--json':
        options.raw = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--apify':
        options.useApify = true;
        break;
      case '--apify-dataset':
        if (i + 1 >= argv.length) {
          throw new Error('--apify-dataset requires a dataset id.');
        }
        options.apifyDatasetId = argv[i + 1];
        i += 1;
        break;
      case '--apify-actor':
        if (i + 1 >= argv.length) {
          throw new Error('--apify-actor requires an actor id.');
        }
        options.apifyActorId = argv[i + 1];
        i += 1;
        break;
      case '--apify-input':
        if (i + 1 >= argv.length) {
          throw new Error('--apify-input requires a path.');
        }
        options.apifyInputPath = argv[i + 1];
        i += 1;
        break;
      case '--apify-wait':
        if (i + 1 >= argv.length) {
          throw new Error('--apify-wait requires a numeric value.');
        }
        options.apifyWait = toPositiveNumber(argv[i + 1], '--apify-wait');
        i += 1;
        break;
      case '--apify-limit':
        if (i + 1 >= argv.length) {
          throw new Error('--apify-limit requires a numeric value.');
        }
        options.apifyLimit = toPositiveNumber(argv[i + 1], '--apify-limit');
        i += 1;
        break;
      case '--min-delay-hours':
        if (i + 1 >= argv.length) {
          throw new Error('--min-delay-hours requires a numeric value.');
        }
        options.minDelayHours = toPositiveNumber(
          argv[i + 1],
          '--min-delay-hours',
        );
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function showUsage() {
  console.log('AutoRescue end-to-end demo script');
  console.log('Usage: node scripts/e2e-demo.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --event, -e <path>        Use a specific incident JSON file.');
  console.log('  --demo                    Force simulation mode for all services.');
  console.log('  --live                    Require live calls to Apify, Airia, Redpanda, Sentry.');
  console.log('  --apify                   Fetch incident data from Apify using env configuration.');
  console.log('  --apify-dataset <id>      Override APIFY_DATASET_ID for this run.');
  console.log('  --apify-actor <id>        Override APIFY_ACTOR_ID for this run.');
  console.log('  --apify-input <path>      Provide actor input JSON for Apify runs.');
  console.log('  --apify-limit <n>         Limit items retrieved from Apify dataset.');
  console.log('  --apify-wait <seconds>    Wait time for Apify actor completion.');
  console.log('  --min-delay-hours <n>     Minimum delay threshold when filtering Apify items.');
  console.log('  --raw | --json            Print the full workflow result payload.');
  console.log('  --help, -h                Show this message.');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/e2e-demo.js');
  console.log('  node scripts/e2e-demo.js --demo --raw');
  console.log('  node scripts/e2e-demo.js --live --apify-dataset Dc5xXYZ --raw');
}

function toPositiveNumber(value, flagName) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${flagName} requires a positive number.`);
  }
  return num;
}

function resolveApifyConfig(options, env) {
  return {
    datasetId: options.apifyDatasetId ?? env.APIFY_DATASET_ID ?? null,
    actorId: options.apifyActorId ?? env.APIFY_ACTOR_ID ?? null,
    inputPath: options.apifyInputPath ?? env.APIFY_INPUT_PATH ?? null,
    waitForFinish:
      options.apifyWait ??
      toNumber(env.APIFY_WAIT_FOR_FINISH, 60),
    limit:
      options.apifyLimit ??
      toNumber(env.APIFY_DATASET_LIMIT, 25),
    minDelayHours:
      options.minDelayHours ??
      toNumber(env.APIFY_MIN_DELAY_HOURS, 24),
  };
}

function toNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function shouldUseApify({ options, apifyConfig }) {
  if (options.useApify) return true;
  if (options.demo) return false;
  if (options.live) {
    return Boolean(apifyConfig.datasetId || apifyConfig.actorId);
  }
  return false;
}

function resolveAiriaMode({ options, env, airiaClient }) {
  if (options.demo) return true;
  if (options.live) {
    if (!airiaClient.isConfigured || !env.AIRIA_DEPLOYMENT_ID) {
      throw new Error(
        '--live requires AIRIA_API_KEY and AIRIA_DEPLOYMENT_ID to be set.',
      );
    }
    if (env.SIMULATE_AIRIA === '1') {
      console.warn('Ignoring SIMULATE_AIRIA=1 because --live was provided.');
    }
    return false;
  }
  if (env.SIMULATE_AIRIA === '1') return true;
  if (env.SIMULATE_AIRIA === '0') {
    if (!airiaClient.isConfigured || !env.AIRIA_DEPLOYMENT_ID) {
      console.warn(
        'SIMULATE_AIRIA=0 but Airia credentials missing; falling back to simulation.',
      );
      return true;
    }
    return false;
  }
  return true;
}

function resolveRedpandaMode({ options, env }) {
  if (options.demo) return true;
  if (options.live) {
    if (!hasRedpandaConfig(env)) {
      throw new Error(
        '--live requires Redpanda configuration (HTTP proxy or brokers).',
      );
    }
    if (env.SIMULATE_REDPANDA === '1') {
      console.warn('Ignoring SIMULATE_REDPANDA=1 because --live was provided.');
    }
    return false;
  }
  if (env.SIMULATE_REDPANDA === '1') return true;
  if (env.SIMULATE_REDPANDA === '0') {
    if (!hasRedpandaConfig(env)) {
      console.warn(
        'SIMULATE_REDPANDA=0 but Redpanda configuration missing; falling back to outbox mode.',
      );
      return true;
    }
    return false;
  }
  return true;
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

async function buildSentryClientFromEnv(env) {
  const token = env.SENTRY_TOKEN;
  if (!token) {
    return { client: null, configured: false, reason: 'token-missing' };
  }
  try {
    const client = new SentryClient({
      token,
      baseUrl: env.SENTRY_BASE_URL,
      organizationSlug: env.SENTRY_ORG_SLUG,
      projectSlug: env.SENTRY_PROJECT_SLUG,
    });
    await client.ensureOrganizationSlug();
    await client.ensureProjectSlug();
    return { client, configured: true };
  } catch (error) {
    console.warn(
      'Sentry client disabled due to configuration error:',
      error.message,
    );
    return { client: null, configured: false, reason: error.message };
  }
}

function assertLiveRequirements({
  simulateAiria,
  simulateRedpanda,
  useApify,
  airiaClient,
  apifyConfig,
  sentrySetup,
  env,
}) {
  if (simulateAiria) {
    throw new Error(
      '--live still fell back to Airia simulation; check AIRIA_API_KEY and AIRIA_DEPLOYMENT_ID.',
    );
  }
  if (!airiaClient.isConfigured) {
    throw new Error('AIRIA_API_KEY is required for --live.');
  }
  if (!env.AIRIA_DEPLOYMENT_ID) {
    throw new Error('AIRIA_DEPLOYMENT_ID is required for --live.');
  }
  if (simulateRedpanda) {
    throw new Error(
      '--live still fell back to Redpanda simulation; configure REDPANDA_HTTP_BASE_URL or REDPANDA_BROKERS.',
    );
  }
  if (!useApify) {
    throw new Error(
      '--live expects Apify involvement; provide --apify or set APIFY_DATASET_ID/APIFY_ACTOR_ID.',
    );
  }
  if (!process.env.APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is required for Apify live runs.');
  }
  if (!apifyConfig.datasetId && !apifyConfig.actorId) {
    throw new Error(
      'Provide APIFY_DATASET_ID or APIFY_ACTOR_ID to source incidents in --live mode.',
    );
  }
  if (!sentrySetup.client) {
    throw new Error(
      'SENTRY_TOKEN (and organization/project access) is required for --live to log artifacts.',
    );
  }
}

async function loadIncident({ options, apifyConfig, useApify }) {
  if (useApify) {
    const apifyResult = await loadIncidentFromApify(apifyConfig);
    return {
      incident: apifyResult.incident,
      apifyMeta: {
        datasetId: apifyResult.datasetId,
        runId: apifyResult.runId,
      },
      incidentSource: apifyResult.datasetId
        ? `apify-dataset:${apifyResult.datasetId}`
        : `apify-actor:${apifyConfig.actorId}`,
    };
  }

  const incidentPath = options.eventPath ?? DEFAULT_EVENT_PATH;
  const incident = await loadEvent(incidentPath);
  return {
    incident,
    apifyMeta: null,
    incidentSource: `file:${relative(
      repoRoot,
      resolvePath(incidentPath),
    )}`,
  };
}

async function loadEvent(pathLike) {
  const absolute = resolvePath(pathLike);
  const raw = await readFile(absolute, 'utf-8');
  return JSON.parse(raw);
}

function resolvePath(input) {
  if (input.startsWith('file://')) {
    return fileURLToPath(new URL(input));
  }
  if (input.startsWith('/')) {
    return input;
  }
  return resolve(repoRoot, input);
}

async function loadIncidentFromApify({
  datasetId,
  actorId,
  inputPath,
  waitForFinish,
  limit,
  minDelayHours,
}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN is required when sourcing incidents from Apify.');
  }

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
        'Set APIFY_ACTOR_ID or provide --apify-dataset when using the Apify integration.',
      );
    }

    let inputPayload;
    if (inputPath) {
      inputPayload = await loadEvent(inputPath);
    } else if (process.env.APIFY_INPUT_PATH) {
      inputPayload = await loadEvent(process.env.APIFY_INPUT_PATH);
    } else if (process.env.APIFY_INPUT_JSON) {
      inputPayload = JSON.parse(process.env.APIFY_INPUT_JSON);
    } else {
      inputPayload = await loadDefaultApifyInput();
    }

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
      throw new Error(`Apify actor run ${runId} ended with status ${run.status}.`);
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

  const incident = selectIncidentFromItems(items, { minDelayHours });
  if (!incident) {
    throw new Error(
      `No dataset items met delay threshold (${minDelayHours} hours).`,
    );
  }

  incident.source = incident.source ?? 'apify-actor';
  return {
    incident,
    datasetId: resolvedDatasetId,
    runId,
  };
}

async function loadDefaultApifyInput() {
  try {
    return await loadEvent(DEFAULT_APIFY_INPUT_PATH);
  } catch (error) {
    console.warn(
      `Apify actor input not provided and sample payload ${DEFAULT_APIFY_INPUT_PATH} could not be loaded (${error.message}).`,
    );
    return undefined;
  }
}

function selectIncidentFromItems(items, { minDelayHours = 24 } = {}) {
  for (const item of items) {
    const incident = mapDatasetItemToIncident(item, { minDelayHours });
    if (incident) return incident;
  }
  return null;
}

function renderSummary({
  incident,
  incidentSource,
  result,
  durationMs,
  simulateAiria,
  simulateRedpanda,
  eventTopic,
  actionTopic,
  options,
  apifyMeta,
  sentrySetup,
}) {
  const summary = buildRunSummary(result);
  const outboxDir = process.env.OUTBOX_DIR ?? 'outbox';

  console.log('=== AutoRescue End-to-End Demo ===');
  console.log(
    `Mode: Airia ${simulateAiria ? 'simulation' : 'live'} | Redpanda ${simulateRedpanda ? 'outbox' : 'live'}`,
  );
  console.log(`Duration: ${durationMs} ms`);
  console.log('');

  console.log('Services');
  console.log(
    `  Apify: ${apifyMeta ? describeApifyMeta(apifyMeta) : 'local fixture'}`,
  );
  console.log(
    `  Airia: ${simulateAiria ? 'simulation (data/simulations/airia-decision.json)' : 'live agent execution via /v1/JobOrchestration'}`,
  );
  console.log(
    `  Redpanda: ${simulateRedpanda ? 'outbox writer' : 'HTTP/Kafka producer'}`,
  );
  console.log(
    `  Sentry: ${describeSentryStatus(result?.sentry, sentrySetup, simulateAiria)}`,
  );
  console.log('');

  console.log('Incident');
  console.log(`  Source:      ${incidentSource}`);
  console.log(`  Incident ID: ${incident.incidentId}`);
  console.log(`  Order ID:    ${incident.orderId}`);
  console.log(`  Delay hours: ${incident.delayHours ?? 'n/a'}`);
  console.log(
    `  Carrier:     ${incident.carrierStatus?.description ?? 'n/a'}`,
  );
  console.log('');

  console.log('Decision');
  console.log(`  Tool call:   ${summary.decision}`);
  console.log(`  Policy ok:   ${summary.policy.allowed ? 'yes' : 'no'}`);
  if (Array.isArray(summary.policy.reasons) && summary.policy.reasons.length) {
    summary.policy.reasons.forEach((reason, index) => {
      console.log(`    Reason ${index + 1}: ${reason}`);
    });
  }
  if (result?.decision?.customerMessage) {
    console.log(`  Message:     ${result.decision.customerMessage}`);
  }
  console.log('');

  if (result?.actionPlan) {
    console.log('Action plan');
    console.log(`  Type:    ${result.actionPlan.type}`);
    console.log(`  Summary: ${result.actionPlan.summary}`);
    const tasks = Array.isArray(result.actionPlan.tasks)
      ? result.actionPlan.tasks
      : [];
    tasks.forEach((task, index) => {
      console.log(`    ${index + 1}. ${task.system} → ${task.action}`);
      if (task.payload) {
        console.log(`       payload: ${JSON.stringify(task.payload, null, 2)}`);
      }
    });
    console.log(`  Policy proof: ${result.actionPlan.policyProof ?? 'n/a'}`);
    console.log('');
  }

  if (Array.isArray(result?.nextSteps) && result.nextSteps.length) {
    console.log('Next steps');
    result.nextSteps.forEach((step, index) => {
      console.log(`  ${index + 1}. ${step.description} (owner: ${step.owner})`);
    });
    console.log('');
  }

  console.log('Redpanda delivery');
  console.log(
    `  Event topic:  ${eventTopic} → ${summary.redpanda.event ?? 'skipped'}`,
  );
  console.log(
    `  Action topic: ${actionTopic} → ${summary.redpanda.action ?? 'skipped'}`,
  );

  if (simulateRedpanda) {
    const eventFile = formatOutboxPath(outboxDir, eventTopic);
    const actionFile = formatOutboxPath(outboxDir, actionTopic);
    console.log('  Outbox files:');
    if (eventFile) {
      console.log(`    ${eventFile}`);
    }
    if (actionFile) {
      console.log(`    ${actionFile}`);
    }
  }

  console.log('');
  if (!options.raw) {
    console.log('Tip: add --raw to see the full JSON payload.');
  }
}

function describeApifyMeta(meta) {
  if (!meta) return 'n/a';
  if (meta.runId && meta.datasetId) {
    return `actor run ${meta.runId} → dataset ${meta.datasetId}`;
  }
  if (meta.datasetId) {
    return `dataset ${meta.datasetId}`;
  }
  if (meta.runId) {
    return `actor run ${meta.runId}`;
  }
  return 'apify';
}

function describeSentryStatus(sentryResult, sentrySetup, simulateAiria) {
  if (!sentrySetup?.client) {
    const reason = sentrySetup?.reason ?? 'not configured';
    return `skipped (${reason})`;
  }
  if (simulateAiria) {
    return 'skipped (simulation mode)';
  }
  if (!sentryResult) {
    return 'no response';
  }
  if (sentryResult.status === 'ok') {
    return 'ok (release + deploy recorded)';
  }
  if (sentryResult.status === 'failed') {
    return `failed (${sentryResult.error ?? 'unknown error'})`;
  }
  if (sentryResult.status === 'skipped') {
    return `skipped (${sentryResult.reason ?? 'unknown reason'})`;
  }
  return sentryResult.status;
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

function formatOutboxPath(outboxDir, topic) {
  if (!topic) return null;
  const absolute = resolve(repoRoot, outboxDir, `${topic}.jsonl`);
  return relative(repoRoot, absolute);
}

main().catch((error) => {
  console.error('AutoRescue demo failed:', error);
  process.exitCode = 1;
});
