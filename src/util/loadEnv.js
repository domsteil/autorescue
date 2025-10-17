import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadEnvironment() {
  const files = [
    new URL('../../.env', import.meta.url),
    new URL('../../.env.local', import.meta.url),
  ];
  for (const fileUrl of files) {
    try {
      const path = fileURLToPath(fileUrl);
      if (existsSync(path)) {
        dotenv.config({ path });
      }
    } catch (error) {
      // ignore loading errors
    }
  }
}
