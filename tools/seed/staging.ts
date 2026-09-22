// `pnpm seed:staging`: fills an EMPTY staging database with the local world
// (tools/seed/local-world.ts): the production schema and permissions, the first admin, cities,
// restaurants and menus, managers, drivers, customers and a month of orders. Run once, after the
// first deploy; a database that already has users is left alone.
//
// Staging accepts its master key only from the server's own host (MASTER_KEY_IPS), so this boots a
// throwaway v2 server on 127.0.0.1 with the staging config (.env.staging + the secret version it
// pins, read with your `gcloud auth application-default login`), seeds through it and stops it.
// Its dispatch worker stays off. Every account gets SEED_PASSWORD: staging is on the internet.
//
//   SEED_PASSWORD='12+ characters' pnpm seed:staging
import { createServer } from 'node:http';
import { type AddressInfo, createServer as createProbe } from 'node:net';
import { MongoClient } from 'mongodb';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/load.js';
import { createLogger } from '../../src/observability/logger.js';
import { SEED_LOGINS, seedLocalWorld } from './local-world.js';

const password = process.env.SEED_PASSWORD ?? '';
if (password.length < 12) {
  throw new Error('Set SEED_PASSWORD (12+ characters): every staging account gets it.');
}

/** A free port on 127.0.0.1 for the throwaway server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const env = await loadConfig({
  APP_ENV: 'staging',
  PORT: String(port),
  PARSE_SERVER_URL: `http://127.0.0.1:${port}`,
  DISPATCH_WORKER_ENABLED: 'false',
  LOG_LEVEL: 'warn',
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    /credentials/i.test(message)
      ? `${message}\nRun \`gcloud auth application-default login\` first (docs/05-staging.md).`
      : message,
  );
});

const mongo = new MongoClient(env.DATABASE_URI);
let empty: boolean;
try {
  await mongo.connect();
  empty = (await mongo.db().collection('_User').countDocuments({}, { limit: 1 })) === 0;
} finally {
  await mongo.close();
}
if (!empty) {
  process.stdout.write('The staging database already has users; nothing seeded.\n');
  process.exit(0);
}

const switchApp = await createApp(env, { logger: createLogger(env.LOG_LEVEL) });
const server = createServer(switchApp.app);
switchApp.attach(server);
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
try {
  await seedLocalWorld({
    serverUrl: `http://127.0.0.1:${port}`,
    appId: env.PARSE_APP_ID,
    masterKey: env.PARSE_MASTER_KEY,
    databaseUri: env.DATABASE_URI,
    password,
  });
} finally {
  await switchApp.close();
}

const width = Math.max(...SEED_LOGINS.map((l) => l.username.length));
process.stdout.write(
  [
    `Seeded staging (${env.PARSE_PUBLIC_SERVER_URL}).`,
    '',
    '  Staging accounts (password: your SEED_PASSWORD):',
    ...SEED_LOGINS.map((l) => `    ${l.username.padEnd(width)}  ${l.who}  [${l.app}]`),
    '',
  ].join('\n') + '\n',
);
