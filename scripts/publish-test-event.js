#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { loadEnvironment } from '../src/util/loadEnv.js';
import { buildRedpandaClientFromEnv } from '../src/util/redpandaFactory.js';

async function main() {
  loadEnvironment();

  const topic = process.argv[2] ?? process.env.REDPANDA_EVENTS_TOPIC;
  const eventPath = process.argv[3] ?? '../data/events/sample-delay-event.json';

  if (!topic) {
    throw new Error(
      'Specify topic: npm run publish:test-event -- <topic> [eventPath]',
    );
  }

  const url = new URL(eventPath, import.meta.url);
  const payload = JSON.parse(await readFile(url, 'utf-8'));

  const client = await buildRedpandaClientFromEnv();
  if (!client?.isConfigured) {
    throw new Error('Redpanda client is not configured.');
  }

  await client.produce(topic, [
    {
      key: payload.orderId ?? payload.incidentId ?? null,
      value: {
        type: payload.type ?? 'shipment_delay',
        payload,
      },
    },
  ]);

  if (typeof client.close === 'function') {
    await client.close();
  }

  console.log(`Published test event to ${topic} from ${eventPath}`);
}

main().catch((error) => {
  console.error('Failed to publish test event:', error);
  process.exit(1);
});
