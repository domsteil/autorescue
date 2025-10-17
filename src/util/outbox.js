import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_OUTBOX_DIR = 'outbox';

export async function persistOutboxRecord(topic, payload) {
  const dir = process.env.OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR;
  if (!dir) return;

  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${topic}.jsonl`);
    const line = `${JSON.stringify({
      topic,
      timestamp: new Date().toISOString(),
      payload,
    })}\n`;
    await appendFile(filePath, line, { encoding: 'utf-8' });
  } catch (error) {
    console.warn(`Failed to persist outbox record for topic ${topic}: ${error.message}`);
  }
}
