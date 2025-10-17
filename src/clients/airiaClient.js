import { URL, URLSearchParams } from 'node:url';
import { nodeFetch } from './httpClient.js';

const DEFAULT_BASE_URL = 'https://api.airia.ai';

/**
 * Lightweight Airia Platform API client constructed directly from the OpenAPI contract.
 */
export class AiriaClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] - Airia API base URL.
   * @param {string} [options.apiKey] - Bearer token for the tenant.
   * @param {string} [options.projectId] - Optional project scope for agent jobs.
   * @param {string} [options.correlationId] - Optional default correlation id.
   */
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    apiKey,
    projectId,
    correlationId,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.defaultCorrelationId = correlationId;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * Generic request helper.
   * @param {string} path
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {object} [options.query]
   * @param {object} [options.body]
   * @param {object} [options.headers]
   */
  async request(path, { method = 'GET', query, body, headers } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      url.search = new URLSearchParams(query).toString();
    }

    const response = await nodeFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
        ...(this.projectId ? { 'x-project-id': this.projectId } : {}),
        ...(this.defaultCorrelationId
          ? { 'x-correlation-id': this.defaultCorrelationId }
          : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Airia API ${method} ${url.pathname} failed with ${response.status}: ${errorText}`,
      );
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  /**
   * GET /v1/AgentCard — retrieve paginated cards.
   * @param {object} [options]
   * @param {number} [options.pageNumber]
   * @param {number} [options.pageSize]
   * @param {string} [options.sortBy]
   * @param {'ASC'|'DESC'} [options.sortDirection]
   * @param {string} [options.filter]
   * @param {string} [options.projectId]
   */
  async listAgentCards({
    pageNumber,
    pageSize,
    sortBy,
    sortDirection,
    filter,
    projectId,
  } = {}) {
    const query = {};
    if (pageNumber != null) query.PageNumber = pageNumber;
    if (pageSize != null) query.PageSize = pageSize;
    if (sortBy) query.SortBy = sortBy;
    if (sortDirection) query.SortDirection = sortDirection;
    if (filter) query.Filter = filter;
    if (projectId) query.projectId = projectId;

    return this.request('/v1/AgentCard', {
      query: Object.keys(query).length ? query : undefined,
    });
  }

  /**
   * GET /v1/AgentCard/{agentCardId} — retrieve a specific card.
   * @param {string} agentCardId
   */
  async getAgentCard(agentCardId) {
    return this.request(`/v1/AgentCard/${agentCardId}`);
  }

  async getProjectByName(name) {
    try {
      return await this.request(`/v1/Project/by-name/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error.message && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async createProject(projectDto) {
    await this.request('/v1/Project', {
      method: 'POST',
      body: projectDto,
    });
  }

  /**
   * POST /v1/AgentCard — create or update the core agent metadata.
   * @param {object|object[]} model
   */
  async createAgentCard(model) {
    const payload = Array.isArray(model) ? model : [model];
    return this.request('/v1/AgentCard', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * POST /v1/JobOrchestration — enqueue an AgentExecution job.
   * @param {object} payload
   * @param {string} payload.name
   * @param {string} [payload.externalId]
   * @param {object} payload.parameters - Raw parameters delivered to the job.
   * @param {boolean} [payload.pollingEnabled]
   */
  async triggerAgentExecution({
    name,
    externalId,
    parameters,
    pollingEnabled = true,
    executionSettings,
    resilienceSettings,
    taskResilienceSettings,
  }) {
    const body = {
      name,
      externalId,
      jobType: 'AgentExecution',
      source: 'PlatformApi',
      jobParameters: JSON.stringify(parameters),
      pollingEnabled,
    };

    if (this.projectId) {
      body.projectId = this.projectId;
    }
    if (executionSettings) {
      body.jobExecutionSettings = executionSettings;
    }
    if (resilienceSettings) {
      body.jobResilienceSettings = resilienceSettings;
    }
    if (taskResilienceSettings) {
      body.jobTaskResilienceSettings = taskResilienceSettings;
    }

    return this.request('/v1/JobOrchestration', {
      method: 'POST',
      body,
    });
  }

  /**
   * GET /v1/Deployments — list deployments grouped by project.
   */
  async listDeployments() {
    return this.request('/v1/Deployments');
  }

  /**
   * POST /v1/Deployments — create a new deployment.
   * @param {object} payload
   */
  async createDeployment(payload) {
    return this.request('/v1/Deployments', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * GET /v1/JobOrchestration/{id} — fetch job status.
   * @param {string} jobId
   */
  async getJob(jobId) {
    return this.request(`/v1/JobOrchestration/${jobId}`);
  }

  /**
   * GET /v1/JobOrchestration/{id}/result — fetch job result payloads.
   * @param {string} jobId
   */
  async getJobResult(jobId) {
    return this.request(`/v1/JobOrchestration/${jobId}/result`);
  }
}
