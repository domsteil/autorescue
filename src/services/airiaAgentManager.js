export class AiriaAgentManager {
  /**
   * @param {import('../clients/airiaClient.js').AiriaClient} airiaClient
   */
  constructor(airiaClient) {
    this.airiaClient = airiaClient;
  }

  /**
   * @param {object} agentConfig
   * @returns {{created:boolean, card:object}}
   */
  async ensureAgentCard(agentConfig) {
    const cards = await this.airiaClient.listAgentCards({
      filter: agentConfig.name,
      projectId: agentConfig.projectId,
      pageSize: 200,
    });

    const existing = this.findAgentCardByName(cards, agentConfig.name);
    if (existing) {
      return { created: false, card: existing };
    }

    const creationResponses = await this.airiaClient.createAgentCard(
      agentConfig,
    );
    const firstResponse = Array.isArray(creationResponses)
      ? creationResponses[0]
      : creationResponses;
    if (firstResponse && firstResponse.success === false) {
      throw new Error(
        `Airia failed to create agent card: ${firstResponse.errorMessage ?? 'unknown error'}`,
      );
    }
    let createdCard = null;
    if (firstResponse?.createdId) {
      try {
        createdCard = await this.airiaClient.getAgentCard(firstResponse.createdId);
      } catch (error) {
        console.warn(
          `Unable to retrieve created agent card ${firstResponse.createdId}:`,
          error.message,
        );
      }
    }
    return { created: true, card: createdCard ?? firstResponse };
  }

  findAgentCardByName(cardsResponse, name) {
    if (!cardsResponse) return null;
    let entries = [];
    if (Array.isArray(cardsResponse?.items)) {
      entries = cardsResponse.items;
    } else if (Array.isArray(cardsResponse?.data)) {
      entries = cardsResponse.data;
    } else if (Array.isArray(cardsResponse)) {
      entries = cardsResponse;
    }
    return entries.find(
      (card) => card?.name?.toLowerCase() === name?.toLowerCase(),
    );
  }

  async listDeployments() {
    const deployments = await this.airiaClient.listDeployments();
    return this.flattenDeployments(deployments);
  }

  flattenDeployments(deployments) {
    if (!deployments) return [];
    if (Array.isArray(deployments)) return deployments;
    return Object.entries(deployments).flatMap(([projectId, items]) =>
      (items ?? []).map((item) => ({ projectId, ...item })),
    );
  }

  async findDeployment({ projectId, deploymentName, pipelineId }) {
    const deployments = await this.listDeployments();
    return deployments.find((deployment) => {
      if (projectId && deployment.projectId?.toLowerCase() !== projectId.toLowerCase()) {
        return false;
      }
      if (
        deploymentName &&
        deployment.deploymentName?.toLowerCase() !== deploymentName.toLowerCase()
      ) {
        return false;
      }
      if (
        pipelineId &&
        deployment.pipelineId?.toLowerCase() !== pipelineId.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
  }

  async ensureDeploymentId(options) {
    const deployment = await this.findDeployment(options);
    if (!deployment) {
      return {
        found: false,
        message:
          'Deployment not located. Verify pipeline or deployment name in config before creating agents.',
      };
    }
    return { found: true, deploymentId: deployment.id, deployment };
  }
}
