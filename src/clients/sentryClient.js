import { URL, URLSearchParams } from 'node:url';
import { nodeFetch } from './httpClient.js';

const DEFAULT_BASE_URL = 'https://sentry.io';

export class SentryClient {
  /**
   * @param {object} options
   * @param {string} options.token - Sentry auth token.
   * @param {string} [options.baseUrl]
   * @param {string} [options.organizationSlug]
   * @param {string} [options.projectSlug]
   */
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    organizationSlug,
    projectSlug,
  }) {
    if (!token) {
      throw new Error('Sentry token is required.');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.organizationSlug = organizationSlug ?? null;
    this.projectSlug = projectSlug ?? null;
  }

  get isConfigured() {
    return Boolean(this.token);
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
        `Sentry API ${method} ${url.pathname} failed with ${response.status}: ${errorBody}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  async ensureOrganizationSlug() {
    if (this.organizationSlug) return this.organizationSlug;
    const organizations = await this.request('/api/0/organizations/');
    if (!Array.isArray(organizations) || organizations.length === 0) {
      throw new Error('No organizations available for the provided Sentry token.');
    }
    this.organizationSlug = organizations[0].slug;
    return this.organizationSlug;
  }

  async ensureProjectSlug() {
    if (this.projectSlug) return this.projectSlug;
    const org = await this.ensureOrganizationSlug();
    const projects = await this.request(`/api/0/organizations/${org}/projects/`);
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error(`No projects available for Sentry organization ${org}.`);
    }
    this.projectSlug = projects[0].slug;
    return this.projectSlug;
  }

  async listIssues({ query, limit = 5 } = {}) {
    const org = await this.ensureOrganizationSlug();
    return this.request(`/api/0/organizations/${org}/issues/`, {
      query: {
        query,
        limit: Math.min(limit, 100),
      },
    });
  }

  /**
   * Create or reuse a release for the organization.
   * @param {object} options
   * @param {string} options.version
   * @param {string[]} [options.projects]
   * @param {string} [options.releaseNotes]
   * @param {string} [options.url]
   * @param {string} [options.dateReleased]
   */
  async createRelease({
    version,
    projects,
    releaseNotes,
    url,
    dateReleased,
  }) {
    const org = await this.ensureOrganizationSlug();
    const projectSlug = await this.ensureProjectSlug();
    const payload = {
      version,
      projects: projects && projects.length > 0 ? projects : [projectSlug],
    };
    if (releaseNotes) {
      payload.notes = releaseNotes;
    }
    if (url) {
      payload.url = url;
    }
    if (dateReleased) {
      payload.dateReleased = dateReleased;
    }

    try {
      return await this.request(`/api/0/organizations/${org}/releases/`, {
        method: 'POST',
        body: payload,
      });
    } catch (error) {
      // Sentry returns 208 Already Reported if the release exists.
      if (error.message.includes('208')) {
        return {
          version,
          projects: payload.projects,
          alreadyExists: true,
        };
      }
      throw error;
    }
  }

  /**
   * Record a deploy for the release.
   * @param {object} options
   * @param {string} options.version
   * @param {string} [options.environment]
   * @param {string} [options.name]
   * @param {string} [options.url]
   * @param {string} [options.dateStarted]
   * @param {string} [options.dateFinished]
   */
  async createDeploy({
    version,
    environment = 'production',
    name,
    url,
    dateStarted,
    dateFinished,
  }) {
    const org = await this.ensureOrganizationSlug();
    const body = {
      environment,
    };
    if (name) body.name = name;
    if (url) body.url = url;
    if (dateStarted) body.dateStarted = dateStarted;
    if (dateFinished) body.dateFinished = dateFinished;

    return this.request(
      `/api/0/organizations/${org}/releases/${encodeURIComponent(
        version,
      )}/deploys/`,
      {
        method: 'POST',
        body,
      },
    );
  }
}
