import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadEnvironment } from '../../src/util/loadEnv.js';
import { buildDashboardData } from '../../src/services/dashboardDataService.js';

async function bootstrap() {
  loadEnvironment();

  const app = express();
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(currentDir, 'public');

  app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

  app.get('/api/dashboard', async (req, res) => {
    try {
      const payload = await buildDashboardData();
      res.set('Cache-Control', 'no-store');
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const host = process.env.DASHBOARD_HOST ?? '127.0.0.1';
  const port = Number(process.env.DASHBOARD_PORT ?? '3100');

  const server = app.listen(port, host, () => {
    const address = server.address();
    const displayHost = address.address === '::' ? 'localhost' : address.address;
    console.log(`AutoRescue dashboard listening on http://${displayHost}:${address.port}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start dashboard server:', error);
  process.exitCode = 1;
});
