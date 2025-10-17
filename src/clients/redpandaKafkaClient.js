function normalizeMechanism(mechanism) {
  if (!mechanism) return undefined;
  const lower = mechanism.toLowerCase();
  if (lower === 'scram-sha-256' || lower === 'scram_sha_256') {
    return 'scram-sha-256';
  }
  if (lower === 'scram-sha-512' || lower === 'scram_sha_512') {
    return 'scram-sha-512';
  }
  if (lower === 'plain') {
    return 'plain';
  }
  return lower;
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

class RedpandaKafkaImplementation {
  constructor(kafkaModule, { brokers, username, password, mechanism, clientId, ssl }) {
    if (!kafkaModule?.Kafka) {
      throw new Error('KafkaJS module is required to instantiate RedpandaKafkaClient.');
    }

    const brokerList = ensureArray(brokers);
    if (brokerList.length === 0) {
      throw new Error(
        'RedpandaKafkaClient requires at least one broker (set REDPANDA_BROKERS or REDPANDA_CLUSTER_ID).',
      );
    }

    const saslConfig =
      username && password
        ? {
            username,
            password,
            mechanism: normalizeMechanism(mechanism) ?? 'scram-sha-256',
          }
        : undefined;

    const sslConfig = ssl ?? (saslConfig ? { rejectUnauthorized: false } : undefined);

    this.kafkaModule = kafkaModule;
    this.kafka = new kafkaModule.Kafka({
      clientId,
      brokers: brokerList,
      ssl: sslConfig ?? true,
      sasl: saslConfig,
      logLevel: kafkaModule.logLevel?.WARN ?? kafkaModule.logLevel?.INFO,
    });
    this.producer = this.kafka.producer();
    this.connected = false;
  }

  get isConfigured() {
    return true;
  }

  async ensureConnected() {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async produce(topic, records) {
    if (!topic) {
      throw new Error('Topic is required when producing via Kafka.');
    }
    if (!Array.isArray(records) || records.length === 0) return null;

    await this.ensureConnected();

    const messages = records.map((record) => ({
      key: record.key ? String(record.key) : undefined,
      value:
        typeof record.value === 'string'
          ? record.value
          : JSON.stringify(record.value),
      partition:
        typeof record.partition === 'number' ? record.partition : undefined,
    }));

    return this.producer.send({
      topic,
      messages,
    });
  }

  async close() {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }
}

export function createRedpandaKafkaClient(kafkaModule, options) {
  return new RedpandaKafkaImplementation(kafkaModule, options);
}
