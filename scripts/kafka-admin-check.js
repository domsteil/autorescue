#!/usr/bin/env node
import { Kafka } from 'kafkajs';

import { loadEnvironment } from '../src/util/loadEnv.js';
import { resolveRedpandaBrokers } from '../src/util/redpandaFactory.js';

async function main() {
  loadEnvironment();

  const brokers =
    process.env.KAFKA_BROKERS ??
    process.env.REDPANDA_BROKERS ??
    resolveRedpandaBrokers(process.env)?.join(',');

  if (!brokers) {
    throw new Error(
      'Set KAFKA_BROKERS or REDPANDA_BROKERS/REDPANDA_CLUSTER_ID before running the admin check.',
    );
  }

  const brokerList = Array.isArray(brokers)
    ? brokers
    : brokers.split(',').map((b) => b.trim());

  const kafka = new Kafka({
    brokers: brokerList,
    clientId: process.env.REDPANDA_CLIENT_ID ?? 'autorescue-admin',
    ssl: { rejectUnauthorized: false },
    sasl: {
      mechanism:
        process.env.KAFKA_SASL_MECHANISM ??
        process.env.REDPANDA_MECHANISM ??
        'scram-sha-256',
      username: process.env.KAFKA_USERNAME ?? process.env.REDPANDA_USERNAME,
      password: process.env.KAFKA_PASSWORD ?? process.env.REDPANDA_PASSWORD,
    },
  });

  const admin = kafka.admin();
  await admin.connect();
  const topics = await admin.listTopics();
  console.log('Connected successfully. Topics:', topics);
  await admin.disconnect();
}

main().catch((error) => {
  console.error('Kafka admin check failed:', error);
  process.exitCode = 1;
});
