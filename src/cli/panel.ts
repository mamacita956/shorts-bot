// Runs the app without the desktop window: panel at http://127.0.0.1:3000 (PORT to change).
import { join } from 'node:path';
import { dashboardHtml, startDashboard } from '../dashboard/server';
import { log } from '../log';
import { startRuntime } from '../runtime';

const root = process.cwd();
const runtime = await startRuntime({ home: process.env.SHORTS_HOME || root, assetsDir: join(root, 'assets') });
const server = await startDashboard(runtime, { host: '127.0.0.1', port: Number(process.env.PORT || 3000), htmlPath: dashboardHtml(root) });
log.info(`Panel: http://127.0.0.1:${server.port}/`);

const stop = () => {
  runtime.stop();
  server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
