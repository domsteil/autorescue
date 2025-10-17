import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_OUTBOX_DIR = 'outbox';

/**
 * Load JSONL entries for a given outbox topic.
 * @param {string} topic
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {string} [options.outboxDir]
 * @returns {Promise<{total:number, latest:Array<object>}>}
 */
export async function readOutboxTopic(topic, { limit = 5, outboxDir } = {}) {
  if (!topic) {
    throw new Error('Topic name is required.');
  }
  const dir = outboxDir ?? process.env.OUTBOX_DIR ?? DEFAULT_OUTBOX_DIR;
  const filePath = join(dir, `${topic}.jsonl`);

  try {
    const contents = await readFile(filePath, 'utf-8');
    const lines = contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const total = lines.length;
    const latest = lines
      .slice(Math.max(total - limit, 0))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return { error: `Unable to parse line: ${error.message}`, raw: line };
        }
      })
      .reverse();
    return { total, latest };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { total: 0, latest: [] };
    }
    throw error;
  }
}
