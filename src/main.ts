import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config/load.js';
import { createLogger } from './observability/logger.js';

// Process entry: load env → secrets → guard → start → graceful shutdown.
const env = await loadConfig();
const logger = createLogger(env.LOG_LEVEL);

process.on('unhandledRejection', (reason) => {
  // Every legacy fire-and-forget call has a .catch (D-4); anything reaching here is a bug.
  logger.error({ err: reason }, 'unhandled rejection');
});

const started = Date.now();
const switchApp = await createApp(env, { logger });
const server = createServer(switchApp.app);
switchApp.attach(server);
server.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      appEnv: env.APP_ENV,
      bootMs: Date.now() - started,
      dispatchWorker: env.DISPATCH_WORKER_ENABLED,
    },
    'Parse Server is running.',
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await switchApp.close();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
