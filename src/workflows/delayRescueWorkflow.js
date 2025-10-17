import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { sanitizeForReport } from '../util/objectSanitizer.js';
import { evaluateDecision } from '../util/policyGuard.js';
import { persistOutboxRecord } from '../util/outbox.js';

const ROOT_RESOLVE = (relativePath) =>
  new URL(relativePath, import.meta.url);

async function readJson(relativePath) {
  const url = ROOT_RESOLVE(relativePath);
  const data = await readFile(url, 'utf-8');
  return JSON.parse(data);
}

/**
 * Delay rescue orchestration flow matching DetectDelay → Decide → Act → Log.
 */
export class DelayRescueWorkflow {
  /**
   * @param {object} options
   * @param {import('../clients/airiaClient.js').AiriaClient} options.airiaClient
   * @param {string} [options.policyPath]
   * @param {boolean} [options.simulate]
   * @param {number} [options.pollIntervalMs]
   * @param {number} [options.maxPollAttempts]
   * @param {string} [options.deploymentId]
   * @param {object} [options.redpandaClient]
   * @param {import('../clients/sentryClient.js').SentryClient} [options.sentryClient]
   * @param {string} [options.eventTopic]
   * @param {string} [options.actionTopic]
   * @param {(decision: any) => void} [options.decisionValidator]
   */
  constructor({
    airiaClient,
    policyPath = '../../config/policy.json',
    simulate = false,
    pollIntervalMs = 2_000,
    maxPollAttempts = 15,
    deploymentId = process.env.AIRIA_DEPLOYMENT_ID,
    redpandaClient,
    eventTopic = process.env.REDPANDA_EVENTS_TOPIC,
    actionTopic = process.env.REDPANDA_ACTIONS_TOPIC,
    sentryClient,
    decisionValidator,
  } = {}) {
    this.airiaClient = airiaClient;
    this.policyPath = policyPath;
    this.simulate = simulate;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollAttempts = maxPollAttempts;
    this.deploymentId = deploymentId;
    this.redpandaClient = redpandaClient;
    this.eventTopic = eventTopic;
    this.actionTopic = actionTopic;
    this.sentryClient = sentryClient;
    this.decisionValidator = decisionValidator;
  }

  async run(event) {
    const policy = await this.loadPolicy();
    const orderContext = await this.fetchOrderContext(event.orderId);

    const redpandaEventStatus = await this.publishToRedpanda(
      this.eventTopic,
      event.orderId,
      {
        type: 'shipment_delay',
        payload: event,
      },
    );

    const agentParameters = this.buildAgentParameters({
      event,
      orderContext,
      policy,
    });

    const rawDecision = await this.obtainDecision(agentParameters, event);
    this.validateDecision(rawDecision);

    const policyReview = evaluateDecision(rawDecision, orderContext, policy);
    const decision = policyReview.allowed
      ? rawDecision
      : {
          ...rawDecision,
          toolCall: {
            name: 'manual_review',
            arguments: {
              reason:
                policyReview.reasons?.join('; ') ?? 'policy violation detected',
            },
          },
          policyProof: `${rawDecision.policyProof ?? ''} (policy override)`.trim(),
        };

    const actionPlan = this.buildActionPlan(decision, orderContext, policy);

    if (!policyReview.allowed) {
      actionPlan.policyProof = `${actionPlan.policyProof ?? ''} (override: ${
        policyReview.reasons?.join('; ') ?? 'policy violation'
      })`.trim();
    }

    const redpandaActionStatus = await this.publishToRedpanda(
      this.actionTopic,
      event.orderId,
      {
        incidentId: event.incidentId,
        orderId: event.orderId,
        decision,
        policyReview,
        actionPlan,
      },
    );

    const redpandaStatus = {
      event: redpandaEventStatus,
      action: redpandaActionStatus,
    };

    return {
      incident: event,
      orderContext,
      policy,
      decision,
      actionPlan,
      nextSteps: this.determineNextSteps(actionPlan),
      policyReview,
      redpandaStatus,
      sentry: await this.recordSentryArtifacts({
        event,
        actionPlan,
        policy,
        redpandaStatus,
      }),
    };
  }

  validateDecision(decision) {
    if (!this.decisionValidator) return;
    const result = this.decisionValidator(decision);
    if (result === true || result === undefined) return;
    if (typeof result === 'string') {
      throw new Error(`Decision validation failed: ${result}`);
    }
    if (Array.isArray(result) && result.length > 0) {
      throw new Error(
        `Decision validation failed: ${result
          .map((error) => (typeof error === 'string' ? error : JSON.stringify(error)))
          .join('; ')}`,
      );
    }
  }

  async loadPolicy() {
    return readJson(this.policyPath);
  }

  async fetchOrderContext(orderId) {
    const orders = await readJson('../../data/orders.json');
    const order = orders[orderId];
    if (!order) {
      throw new Error(`Order ${orderId} not found in local cache.`);
    }
    return order;
  }

  buildAgentParameters({ event, orderContext, policy }) {
    if (!this.deploymentId && !this.simulate) {
      throw new Error(
        'AIRIA_DEPLOYMENT_ID is required to execute the workflow against Airia.',
      );
    }

    const deploymentId = this.deploymentId ?? 'simulation-deployment';
    return {
      deploymentId,
      mode: 'tool',
      incident: {
        id: event.incidentId,
        type: event.type,
        detectedAt: event.detectedAt,
        carrierStatus: event.carrierStatus,
        promisedDeliveryDate: event.promisedDeliveryDate,
      },
      order: orderContext,
      policy,
      instructions:
        'Return a single tool call: create_reshipment, create_coupon, or create_refund. Provide policyProof describing thresholds applied.',
    };
  }

  async obtainDecision(agentParameters, event) {
    if (this.simulate || !this.airiaClient?.isConfigured) {
      return readJson('../../data/simulations/airia-decision.json');
    }

    const job = await this.airiaClient.triggerAgentExecution({
      name: `delay-rescue-${event.orderId}`,
      externalId: event.incidentId,
      parameters: agentParameters,
      pollingEnabled: true,
    });

    return this.pollDecision(job.id);
  }

  async pollDecision(jobId) {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const job = await this.airiaClient.getJob(jobId);
      if (job.status === 'Success') {
        const results = await this.airiaClient.getJobResult(jobId);
        if (!Array.isArray(results) || results.length === 0) {
          throw new Error(`Job ${jobId} succeeded but returned no results.`);
        }
        return results[0];
      }
      if (job.status === 'Failed' || job.status === 'Cancelled') {
        throw new Error(`Job ${jobId} ended with status ${job.status}.`);
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error(
      `Job ${jobId} did not complete within ${this.maxPollAttempts} attempts.`,
    );
  }

  buildActionPlan(decision, orderContext, policy) {
    const call = decision?.toolCall ?? {};
    const action = call.name ?? 'manual_review';
    const proof = decision?.policyProof ?? 'No policy details provided.';

    switch (action) {
      case 'create_reshipment':
        return {
          type: 'reshipment',
          summary: 'Create replacement fulfillment and notify customer.',
          tasks: [
            {
              system: 'Shopify',
              action: 'create_fulfillment',
              payload: {
                orderId: orderContext.shopify.id,
                lineItems: call.arguments?.items,
                shippingMethod: 'expedited',
              },
            },
            {
              system: 'Twilio',
              action: 'send_sms',
              payload: {
                to: orderContext.customer.phone,
                template: 'reshipment_confirmation',
              },
            },
          ],
          policyProof: proof,
        };
      case 'create_coupon':
        return {
          type: 'coupon',
          summary: 'Issue store credit coupon and confirm via SMS.',
          tasks: [
            {
              system: 'Stripe',
              action: 'create_coupon',
              payload: call.arguments,
            },
            {
              system: 'Twilio',
              action: 'send_sms',
              payload: {
                to: orderContext.customer.phone,
                template: 'credit_offer',
              },
            },
          ],
          policyProof: proof,
        };
      case 'create_refund':
        return {
          type: 'refund',
          summary: 'Process partial refund and notify support team.',
          tasks: [
            {
              system: 'Shopify',
              action: 'create_refund',
              payload: call.arguments,
            },
            {
              system: 'Lightfield',
              action: 'log_incident',
              payload: {
                incidentId: decision.incidentId,
                note: 'Refund issued via AutoRescue agent.',
              },
            },
          ],
          policyProof: proof,
        };
      default:
        return {
          type: 'manual_review',
          summary:
            'Escalate to human agent; Airia returned no actionable tool call.',
          tasks: [
            {
              system: 'Sentry',
              action: 'create_breadcrumb',
              payload: {
                severity: 'warning',
                message: 'Manual review required for AutoRescue incident.',
              },
            },
          ],
          policyProof: proof,
        };
    }
  }

  determineNextSteps(actionPlan) {
    const auditStep = {
      description: 'Log outcome to incident timeline and close ticket.',
      owner: 'AutoRescue',
    };

    if (actionPlan.type === 'manual_review') {
      return [
        {
          description: 'Route incident to CX lead with conversation transcript.',
          owner: 'Support',
        },
        auditStep,
      ];
    }

    return [
      {
        description: 'Execute downstream API calls per task list.',
        owner: 'Action Worker',
      },
      {
        description: 'Send confirmation summary to analytics topic.',
        owner: 'Observability',
      },
      auditStep,
    ];
  }

  async recordSentryArtifacts({ event, actionPlan }) {
    if (!this.sentryClient?.isConfigured) {
      return { status: 'skipped', reason: 'client-not-configured' };
    }
    if (this.simulate) {
      return { status: 'skipped', reason: 'simulation-mode' };
    }

    const version = `autorescue-${event.incidentId}`.toLowerCase();
    const now = new Date();
    const dateIso = now.toISOString();
    const summary = `AutoRescue incident ${event.incidentId} resolved with action ${actionPlan.type}.`;

    const response = {
      status: 'pending',
      release: null,
      deploy: null,
      relatedIssues: null,
    };

    try {
      response.release = await this.sentryClient.createRelease({
        version,
        releaseNotes: `${summary}\nPolicy proof: ${actionPlan.policyProof ?? 'n/a'}`,
        dateReleased: dateIso,
      });

      response.deploy = await this.sentryClient.createDeploy({
        version,
        environment: event.environment ?? 'production',
        name: `AutoRescue ${actionPlan.type}`,
        dateStarted: event.detectedAt,
        dateFinished: dateIso,
      });

      try {
        const issues = await this.sentryClient.listIssues({
          query: event.orderId,
          limit: 3,
        });
        response.relatedIssues = Array.isArray(issues)
          ? issues.map(
              ({
                id,
                shortId,
                title,
                status,
                permalink,
                lastSeen,
                firstSeen,
              }) => ({
                id,
                shortId,
                title,
                status,
                permalink,
                lastSeen,
                firstSeen,
              }),
            )
          : issues;
      } catch (issueError) {
        response.relatedIssues = {
          error: issueError.message,
        };
      }

      response.status = 'ok';
    } catch (error) {
      response.status = 'failed';
      response.error = error.message;
    }

    return response;
  }

  async publishToRedpanda(topicName, key, value) {
    if (!topicName) {
      return { status: 'skipped', reason: 'topic-not-configured' };
    }
    if (!this.redpandaClient?.isConfigured) {
      return {
        status: 'skipped',
        topic: topicName,
        reason: 'client-not-configured',
      };
    }
    try {
      const result = await this.redpandaClient.produce(topicName, [
        {
          key,
          value,
        },
      ]);
      return {
        status: 'published',
        topic: topicName,
        result: sanitizeForReport(result),
      };
    } catch (error) {
      await persistOutboxRecord(topicName, { key, value, error: error.message });
      return {
        status: 'failed',
        topic: topicName,
        error: error.message,
        outbox: true,
      };
    }
  }
}
