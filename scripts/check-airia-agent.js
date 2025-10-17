#!/usr/bin/env node
import { loadEnvironment } from '../src/util/loadEnv.js';
import { AiriaClient } from '../src/clients/airiaClient.js';

async function main() {
  loadEnvironment();

  const client = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  if (!client.isConfigured) {
    throw new Error('AIRIA_API_KEY is required.');
  }

  const deployments = await client.listDeployments();
  const flat = Array.isArray(deployments)
    ? deployments
    : Object.entries(deployments ?? {}).flatMap(([projectId, items]) =>
        (items ?? []).map((item) => ({ projectId, ...item })),
      );

  const deploymentId = process.env.AIRIA_DEPLOYMENT_ID;
  const target = deploymentId
    ? flat.find((item) => item.id === deploymentId)
    : null;

  console.log('Airia deployments available:', flat.length);
  if (target) {
    console.log('Active deployment resolved:', JSON.stringify(target, null, 2));
  } else if (deploymentId) {
    console.warn(
      `AIRIA_DEPLOYMENT_ID ${deploymentId} not found. Ensure it matches one of the deployments.`,
    );
  }

  const cards = await client.listAgentCards({
    pageSize: 50,
    projectId: process.env.AIRIA_PROJECT_ID,
  });
  console.log(
    'Agent cards retrieved:',
    Array.isArray(cards?.items) ? cards.items.length : 0,
  );
}

main().catch((error) => {
  console.error('Airia agent check failed:', error);
  process.exit(1);
});
