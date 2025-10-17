#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { loadEnvironment } from '../src/util/loadEnv.js';
import { AiriaClient } from '../src/clients/airiaClient.js';
import { DelayRescueWorkflow } from '../src/workflows/delayRescueWorkflow.js';

loadEnvironment();

const eventArg = process.argv[2] ?? '../data/events/sample-delay-event.json';
const simulate = process.env.SIMULATE_AIRIA === '1';

async function loadEvent(pathLike) {
  const url = new URL(pathLike, import.meta.url);
  const raw = await readFile(url, 'utf-8');
  return JSON.parse(raw);
}

async function main() {
  if (!process.env.AIRIA_API_KEY) {
    throw new Error('AIRIA_API_KEY missing; update .env.local');
  }
  if (!process.env.AIRIA_DEPLOYMENT_ID && !simulate) {
    throw new Error('AIRIA_DEPLOYMENT_ID required for live agent execution.');
  }

  const event = await loadEvent(eventArg);
  const airiaClient = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    projectId: process.env.AIRIA_PROJECT_ID,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  const workflow = new DelayRescueWorkflow({
    airiaClient,
    deploymentId: process.env.AIRIA_DEPLOYMENT_ID,
    simulate,
    eventTopic: null,
    actionTopic: null,
  });

  const result = await workflow.run(event);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('Airia workflow test failed:', error);
  process.exit(1);
});
