import { readFile } from 'node:fs/promises';
import { AiriaClient } from '../clients/airiaClient.js';
import { AiriaAgentManager } from '../services/airiaAgentManager.js';

async function loadConfig(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const data = await readFile(url, 'utf-8');
  return JSON.parse(data);
}

async function main() {
  const configPath =
    process.argv[2] ?? '../../config/airia-agent.json';
  const config = await loadConfig(configPath);

  validateConfigPlaceholders(config);

  if (!process.env.AIRIA_API_KEY) {
    throw new Error('AIRIA_API_KEY is required to manage agent cards.');
  }

  const airiaClient = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    projectId: config?.agentCard?.projectId ?? process.env.AIRIA_PROJECT_ID,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  const manager = new AiriaAgentManager(airiaClient);

  const cardResult = config.agentCard
    ? await manager.ensureAgentCard(config.agentCard)
    : { created: false, card: null };

  const deploymentResult = config.deploymentHint
    ? await manager.ensureDeploymentId(config.deploymentHint)
    : { found: false };

  const summary = {
    agentCard: {
      status: cardResult.created ? 'created' : 'exists',
      name: cardResult.card?.name,
      agentCardId: cardResult.card?.agentCardId,
      projectId: cardResult.card?.projectId,
    },
    deployment: deploymentResult.found
      ? {
          status: 'found',
          deploymentId: deploymentResult.deploymentId,
          projectId: deploymentResult.deployment?.projectId,
          pipelineId: deploymentResult.deployment?.pipelineId,
          deploymentName: deploymentResult.deployment?.deploymentName,
        }
      : {
          status: 'missing',
          hint: deploymentResult.message,
        },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (deploymentResult.found) {
    console.log(
      `Set AIRIA_DEPLOYMENT_ID=${deploymentResult.deploymentId} before running the workflow.`,
    );
  }
}

main().catch((error) => {
  console.error('Airia setup failed:', error);
  process.exitCode = 1;
});

function validateConfigPlaceholders(config) {
  const placeholders = [];
  const agent = config.agentCard ?? {};
  const hint = config.deploymentHint ?? {};

  ['projectId', 'pipelineId', 'deploymentName'].forEach((field) => {
    if (typeof hint[field] === 'string' && hint[field].includes('REPLACE')) {
      placeholders.push(`deploymentHint.${field}`);
    }
  });

  if (typeof agent.projectId === 'string' && agent.projectId.includes('REPLACE')) {
    placeholders.push('agentCard.projectId');
  }

  if (placeholders.length > 0) {
    console.warn(
      `Warning: update the following fields in config before creating assets: ${placeholders.join(', ')}`,
    );
  }
}
