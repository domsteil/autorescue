import { URL } from 'node:url';
import { nodeFetch } from './httpClient.js';

/**
 * Minimal Redpanda HTTP Proxy client backed by the REST endpoints described in cloud-controlplane-openapi-source.json.
 */
export class RedpandaClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - Base URL of the Redpanda HTTP Proxy (for example, https://cluster-id.http.proxy.serverless.redpanda.cloud)
   * @param {string} [options.apiKey] - API key or token for the proxy.
   * @param {string} [options.authorizationHeader] - Header name used for auth (defaults to Authorization).
   * @param {string} [options.authorizationScheme] - Scheme prefix (defaults to Bearer).
   * @param {Record<string,string>} [options.staticHeaders] - Additional headers applied to every request.
   */
  constructor({
    baseUrl,
    apiKey,
    authorizationHeader = 'Authorization',
    authorizationScheme = 'Bearer',
    staticHeaders = {},
  }) {
    if (!baseUrl) {
      throw new Error('RedpandaClient requires a baseUrl.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.authorizationHeader = authorizationHeader;
    this.authorizationScheme = authorizationScheme;
    this.staticHeaders = staticHeaders;
  }

  get isConfigured() {
    return Boolean(this.baseUrl);
  }

  buildAuthHeader() {
    if (!this.apiKey) return {};
    if (!this.authorizationHeader) return {};
    const value = this.authorizationScheme
      ? `${this.authorizationScheme} ${this.apiKey}`
      : this.apiKey;
    return { [this.authorizationHeader]: value };
  }

  /**
   * Produce records to a Redpanda topic using the HTTP proxy.
   * @param {string} topic
   * @param {Array<{key?: string, value: any, partition?: number}>} records
   */
  async produce(topic, records) {
    if (!Array.isArray(records) || records.length === 0) return null;
    if (!topic) {
      throw new Error('Topic is required when producing to Redpanda.');
    }

    const url = new URL(
      `/topics/${encodeURIComponent(topic)}`,
      `${this.baseUrl}/`,
    );

    const payload = {
      records: records.map((record) => {
        const next = { value: record.value };
        if (record.key) next.key = record.key;
        if (typeof record.partition === 'number') {
          next.partition = record.partition;
        }
        return next;
      }),
    };

    const headers = {
      Accept: 'application/vnd.kafka.v2+json',
      'Content-Type': 'application/vnd.kafka.json.v2+json',
      ...this.buildAuthHeader(),
      ...this.staticHeaders,
    };

    const response = await nodeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `Redpanda produce failed (${response.status}): ${bodyText}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }
}
