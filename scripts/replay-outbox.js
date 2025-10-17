#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

import { loadEnvironment } from '../src/util/loadEnv.js';
import { buildRedpandaClientFromEnv } from '../src/util/redpandaFactory.js';

async function main() {
  loadEnvironment();

  const dir = process.argv[2] ?? process.env.OUTBOX_DIR ?? 'outbox';
  const targetTopic = process.argv[3] ?? null;

  const client = await buildRedpandaClientFromEnv();
  if (!client?.isConfigured) {
    throw new Error('Redpanda client is not configured (check brokers or HTTP proxy)');
  }

  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === '.jsonl');

  for (const file of files) {
    const topic = targetTopic ?? file.name.replace(/\\.jsonl$/i, '');
    const path = join(dir, file.name);
    console.log(`Replaying ${path} -> topic ${topic}`);
    const contents = await readFile(path, 'utf-8');
    const records = contents
      .split('\\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          console.warn(`Skipping malformed line: ${line}`);
          return null;
        }
      })
      .filter(Boolean);

    if (records.length === 0) {
      console.log('No records found in', path);
      continue;
    }

    const messages = records.map((record) => ({
      key: record.payload?.key ?? record.payload?.orderId ?? null,
      value: record.payload ?? record,
    }));

    await client.produce(topic, messages);
  }

  if (typeof client.close === 'function') {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Replay failed:', error);
  process.exit(1);
});
