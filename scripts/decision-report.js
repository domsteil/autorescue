#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

function usage() {
  console.log('Usage: node scripts/decision-report.js <log.jsonl>');
  process.exit(1);
}

async function main() {
  const logPath = process.argv[2];
  if (!logPath) usage();

  const stats = {
    total: 0,
    actions: {},
    policyOverrides: 0,
    failures: 0,
  };

  const rl = readline.createInterface({
    input: createReadStream(logPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      stats.failures += 1;
      continue;
    }
    stats.total += 1;
    const action = record?.actionPlan?.type ?? 'unknown';
    stats.actions[action] = (stats.actions[action] ?? 0) + 1;
    if (record?.policyReview && record.policyReview.allowed === false) {
      stats.policyOverrides += 1;
    }
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error('Failed to generate decision report:', error);
  process.exit(1);
});
