import { AiriaClient } from '../clients/airiaClient.js';
import { ApifyClient } from '../clients/apifyClient.js';
import { mapDatasetItemToIncident } from '../lib/incidentMapper.js';
import { readOutboxTopic } from '../util/outboxReader.js';

export async function buildDashboardData({ limit = 5 } = {}) {
  const incidentTopic = process.env.REDPANDA_EVENTS_TOPIC ?? 'carrier-events';
  const actionTopic = process.env.REDPANDA_ACTIONS_TOPIC ?? 'autorescue-actions';
  const minDelayHours = Number(process.env.APIFY_MIN_DELAY_HOURS ?? '24');

  const [events, actions, apifySnapshot, airiaSnapshot] = await Promise.all([
    readOutboxTopic(incidentTopic, { limit }),
    readOutboxTopic(actionTopic, { limit }),
    fetchApifySnapshot({ limit, minDelayHours }),
    fetchAiriaSnapshot(),
  ]);

  const apify = buildApifySummary(events, { apiSnapshot: apifySnapshot, limit });
  const airia = buildAiriaSummary(actions, { apiSnapshot: airiaSnapshot, limit });
  const redpanda = buildRedpandaSummary(events, actions, {
    incidentTopic,
    actionTopic,
  });

  return {
    generatedAt: new Date().toISOString(),
    summary: buildSummary(apify, airia, redpanda),
    apify,
    airia,
    redpanda,
  };
}

function buildApifySummary(events, { apiSnapshot, limit }) {
  const configured = Boolean(process.env.APIFY_TOKEN);
  const hasOutboxData = events.total > 0;
  const incidentsFromApi = apiSnapshot?.incidents ?? [];

  const latestIncidents = incidentsFromApi.length
    ? incidentsFromApi.slice(0, limit).map(mapApiIncident)
    : events.latest
        .map(mapIncidentRecord)
        .filter((item) => item && !item.error);

  const incidentsProcessed = incidentsFromApi.length || events.total;

  const status = incidentsFromApi.length
    ? 'ok'
    : hasOutboxData
      ? 'ok'
      : configured
        ? 'no-data'
        : 'not-configured';

  return {
    status,
    datasetId: apiSnapshot?.datasetId ?? process.env.APIFY_DATASET_ID ?? null,
    incidentsProcessed,
    latestIncidents,
    source: incidentsFromApi.length ? 'api' : hasOutboxData ? 'outbox' : 'none',
    apiError: apiSnapshot?.error ?? null,
  };
}

function buildAiriaSummary(actions, { apiSnapshot, limit }) {
  const configured = Boolean(process.env.AIRIA_API_KEY);
  const hasOutboxData = actions.total > 0;
  const latestDecisions = actions.latest
    .map(mapDecisionRecord)
    .filter((item) => item && !item.error)
    .slice(0, limit);

  const status = hasOutboxData
    ? 'ok'
    : apiSnapshot?.connected
      ? 'no-data'
      : configured
        ? 'config-check'
        : 'not-configured';

  return {
    status,
    deploymentId: process.env.AIRIA_DEPLOYMENT_ID ?? null,
    deployment: apiSnapshot?.deployment ?? null,
    deploymentCount: apiSnapshot?.deploymentCount ?? null,
    connectionStatus: apiSnapshot?.connected
      ? 'connected'
      : configured
        ? 'configured'
        : 'not-configured',
    agentProject: process.env.AIRIA_PROJECT_ID ?? null,
    agentCardsCount: apiSnapshot?.agentCardsCount ?? null,
    latestDecisions,
    decisionsProcessed: actions.total,
    apiError: apiSnapshot?.error ?? null,
    agentCardsError: apiSnapshot?.cardError ?? null,
  };
}

function buildRedpandaSummary(events, actions, { incidentTopic, actionTopic }) {
  const hasData = events.total > 0 || actions.total > 0;
  let connectionMode = 'not-configured';
  if (process.env.SIMULATE_REDPANDA === '1') {
    connectionMode = 'simulated-outbox';
  } else if (process.env.REDPANDA_HTTP_BASE_URL || process.env.REDPANDA_BROKERS) {
    connectionMode = 'configured';
  } else if (hasData) {
    connectionMode = 'outbox-history';
  }

  const latestErrors = events.latest
    .concat(actions.latest)
    .map((record) => ({
      timestamp: record?.timestamp,
      error: record?.payload?.error,
      topic: record?.topic,
    }))
    .filter((item) => item.error)
    .slice(0, 3);

  return {
    status: connectionMode === 'not-configured' ? 'not-configured' : 'ok',
    connectionMode,
    eventsTopic: incidentTopic,
    actionsTopic: actionTopic,
    eventsProcessed: events.total,
    actionsProcessed: actions.total,
    latestEventAt: events.latest[0]?.timestamp ?? null,
    latestActionAt: actions.latest[0]?.timestamp ?? null,
    latestErrors,
  };
}

async function fetchApifySnapshot({ limit, minDelayHours }) {
  const token = process.env.APIFY_TOKEN;
  const datasetId = process.env.APIFY_DATASET_ID;
  if (!token || !datasetId) {
    return null;
  }

  try {
    const client = new ApifyClient({
      baseUrl: process.env.APIFY_BASE_URL,
      token,
    });
    const items = await client.getDatasetItems(datasetId, {
      limit,
      clean: true,
    });
    const incidents = (items ?? [])
      .map((item) => mapDatasetItemToIncident(item, { minDelayHours }))
      .filter(Boolean);
    return { datasetId, incidents };
  } catch (error) {
    return {
      datasetId,
      error: error.message,
      incidents: [],
    };
  }
}

async function fetchAiriaSnapshot() {
  const apiKey = process.env.AIRIA_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = new AiriaClient({
    baseUrl: process.env.AIRIA_BASE_URL,
    apiKey,
    projectId: process.env.AIRIA_PROJECT_ID,
    correlationId: process.env.AIRIA_CORRELATION_ID,
  });

  const result = {
    connected: false,
    deployment: null,
    deploymentCount: null,
    agentCardsCount: null,
    error: null,
    cardError: null,
  };

  try {
    const deployments = await client.listDeployments();
    const flat = flattenDeployments(deployments);
    result.connected = true;
    result.deploymentCount = flat.length;

    const deploymentId = process.env.AIRIA_DEPLOYMENT_ID;
    if (deploymentId) {
      const match = flat.find(
        (item) =>
          (item?.id && String(item.id).toLowerCase() === deploymentId.toLowerCase()) ||
          (item?.deploymentId &&
            String(item.deploymentId).toLowerCase() === deploymentId.toLowerCase()),
      );
      result.deployment = match ?? null;
    } else {
      result.deployment = flat[0] ?? null;
    }
  } catch (error) {
    result.error = error.message;
    return result;
  }

  try {
    const cards = await client.listAgentCards({
      pageSize: 50,
      projectId: process.env.AIRIA_PROJECT_ID,
    });
    if (Array.isArray(cards?.items)) {
      result.agentCardsCount = cards.items.length;
    } else if (Array.isArray(cards?.data)) {
      result.agentCardsCount = cards.data.length;
    } else if (Array.isArray(cards)) {
      result.agentCardsCount = cards.length;
    } else {
      result.agentCardsCount = 0;
    }
  } catch (error) {
    result.cardError = error.message;
  }

  return result;
}

function flattenDeployments(deployments) {
  if (!deployments) return [];
  if (Array.isArray(deployments)) return deployments;
  return Object.entries(deployments).flatMap(([projectId, items]) =>
    (items ?? []).map((item) => ({ projectId, ...item })),
  );
}

function mapIncidentRecord(record) {
  if (!record) return null;
  const wrapper = record?.payload ?? {};
  const eventPayload =
    wrapper?.value?.payload ??
    wrapper?.value ??
    wrapper?.payload ??
    null;

  if (!eventPayload) {
    return {
      error: wrapper?.error ?? 'missing-payload',
      timestamp: record?.timestamp ?? null,
      topic: record?.topic ?? null,
    };
  }

  return {
    incidentId: eventPayload?.incidentId ?? null,
    orderId: eventPayload?.orderId ?? wrapper?.key ?? null,
    delayHours: eventPayload?.delayHours ?? null,
    status: eventPayload?.carrierStatus?.description ?? eventPayload?.type ?? null,
    promisedBy: eventPayload?.promisedDeliveryDate ?? null,
    detectedAt: eventPayload?.detectedAt ?? record?.timestamp ?? null,
    source: eventPayload?.source ?? null,
    timestamp: record?.timestamp ?? null,
  };
}

function mapApiIncident(incident) {
  if (!incident) return null;
  return {
    incidentId: incident.incidentId ?? null,
    orderId: incident.orderId ?? null,
    delayHours: incident.delayHours ?? null,
    status: incident.carrierStatus?.description ?? incident.type ?? null,
    promisedBy: incident.promisedDeliveryDate ?? null,
    detectedAt: incident.detectedAt ?? null,
    source: incident.source ?? null,
    timestamp: incident.detectedAt ?? null,
  };
}

function mapDecisionRecord(record) {
  if (!record) return null;
  const wrapper = record?.payload ?? {};
  const value = wrapper?.value ?? wrapper;
  if (!value) {
    return {
      error: wrapper?.error ?? 'missing-payload',
      timestamp: record?.timestamp ?? null,
      topic: record?.topic ?? null,
    };
  }

  const decision = value?.decision ?? {};
  const actionPlan = value?.actionPlan ?? {};
  const policyReview = value?.policyReview ?? {};

  return {
    incidentId: value?.incidentId ?? null,
    orderId: value?.orderId ?? wrapper?.key ?? null,
    actionType: actionPlan?.type ?? decision?.toolCall?.name ?? 'unknown',
    summary: actionPlan?.summary ?? decision?.customerMessage ?? null,
    latencyMs: decision?.audit?.latencyMs ?? null,
    allowed: policyReview?.allowed ?? null,
    timestamp: record?.timestamp ?? null,
  };
}

function buildSummary(apify, airia, redpanda) {
  return {
    incidentsProcessed: apify?.incidentsProcessed ?? 0,
    decisionsProcessed: airia?.decisionsProcessed ?? 0,
    pipelineMode: redpanda?.connectionMode ?? 'unknown',
    latestEventAt: redpanda?.latestEventAt ?? null,
    latestActionAt: redpanda?.latestActionAt ?? null,
  };
}
