import { URL, URLSearchParams } from 'node:url';
import { nodeFetch } from './httpClient.js';

const DEFAULT_BASE_URL = 'https://api.apify.com';

export class ApifyClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {string} [options.token]
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, token } = {}) {
    if (!token) {
      throw new Error('Apify token is required.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      url.search = new URLSearchParams(query).toString();
    }

    const response = await nodeFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Apify API ${method} ${url.pathname} failed with ${response.status}: ${errorBody}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  /**
   * POST /v2/acts/{actorId}/runs
   */
  async runActor(actorId, { input, build, timeout, memory, maxItems }) {
    const query = {};
    if (build) query.build = build;
    if (timeout != null) query.timeout = timeout;
    if (memory != null) query.memory = memory;
    if (maxItems != null) query.maxItems = maxItems;

    return this.request(`/v2/acts/${actorId}/runs`, {
      method: 'POST',
      query: Object.keys(query).length ? query : undefined,
      body: input,
    });
  }

  /**
   * GET /v2/actor-runs/{runId}
   */
  async getRun(runId, { waitForFinish } = {}) {
    const query = {};
    if (waitForFinish != null) query.waitForFinish = waitForFinish;
    return this.request(`/v2/actor-runs/${runId}`, {
      query: Object.keys(query).length ? query : undefined,
    });
  }

  /**
   * GET /v2/datasets/{datasetId}/items
   */
  async getDatasetItems(datasetId, { limit, clean = true } = {}) {
    const query = {
      format: 'json',
    };
    if (limit != null) query.limit = limit;
    if (clean) query.clean = '1';
    return this.request(`/v2/datasets/${datasetId}/items`, {
      query,
    });
  }
}
