#!/usr/bin/env node
import { loadEnvironment } from '../src/util/loadEnv.js';
import { AiriaClient } from '../src/clients/airiaClient.js';

loadEnvironment();

const projectName = process.argv[2] ?? process.env.AIRIA_PROJECT_NAME ?? `AutoRescue Project ${new Date().toISOString().slice(0, 10)}`;
const agentName = process.argv[3] ?? process.env.AIRIA_AGENT_NAME ?? 'AutoRescue Delay Agent';

async function main() {
  if (!process.env.AIRIA_API_KEY) {
    throw new Error('Set AIRIA_API_KEY before running setup.');
  }

  const client = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey: process.env.AIRIA_API_KEY,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  let project = await client.getProjectByName(projectName);
  if (!project) {
  console.log(`Creating project ${projectName}`);
  await client.createProject({
    name: projectName,
    models: [],
    apiKeys: [],
    prompts: [],
    memories: [],
    pipelines: [],
    dataSources: [],
  });
    project = await client.getProjectByName(projectName);
  } else {
    console.log(`Project ${projectName} already exists (id: ${project.id})`);
  }

  if (!project?.id) {
    throw new Error('Unable to resolve project id after creation.');
  }

  console.log('Project id:', project.id);
  process.env.AIRIA_PROJECT_ID = project.id;

  const cards = await client.listAgentCards({ projectId: project.id, pageSize: 200 });
  const items = Array.isArray(cards?.items) ? cards.items : [];
  const existingCard = items.find((card) => card.name?.toLowerCase() === agentName.toLowerCase());

  if (existingCard) {
    console.log(`Agent card ${agentName} already exists (id: ${existingCard.agentCardId})`);
    return;
  }

  console.log(`Creating agent card ${agentName}`);
  const result = await client.createAgentCard({
    projectId: project.id,
    name: agentName,
    description: 'AutoRescue delay-resolution agent generated via setup script.',
    url: 'https://stateset.com/autorescue',
    provider: {
      organization: 'StateSet',
      url: 'https://stateset.com'
    },
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['json'],
    authentication: {
      schemes: []
    }
  });

  console.log('Agent card creation response:', JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('Airia setup failed:', error);
  process.exit(1);
});
