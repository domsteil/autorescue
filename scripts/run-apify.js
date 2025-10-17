#!/usr/bin/env node
import path from 'node:path';
import { loadEnvironment } from '../src/util/loadEnv.js';

loadEnvironment();

const token = process.env.APIFY_TOKEN;
const actorId = process.env.APIFY_ACTOR_ID;
if (!token || !actorId) {
  console.error('Set APIFY_TOKEN and APIFY_ACTOR_ID in .env.local or the shell environment.');
  process.exit(1);
}

const args = [
  'python',
  'python/apify_signal_runner.py',
  `--token=${token}`,
  `--actor-id=${actorId}`,
  '--input',
  'python/sample_apify_input.json',
  '--wait-for-finish',
  process.env.APIFY_WAIT_FOR_FINISH ?? '90',
];

if (process.env.APIFY_DATASET_ID) {
  args.push('--dataset-id', process.env.APIFY_DATASET_ID);
}
if (process.env.APIFY_TIMEOUT) {
  args.push('--timeout', process.env.APIFY_TIMEOUT);
}

const { spawn } = await import('node:child_process');
const child = spawn(args[0], args.slice(1), { stdio: 'inherit' });
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
