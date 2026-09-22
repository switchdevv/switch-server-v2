// `pnpm seed`: fill the local Docker database with the local world (tools/seed/local-world.ts),
// once. A database that already has users is left alone.
// `pnpm db:reset`: empty every local collection first, then seed.
//
// Needs the Docker stack (`pnpm stack:up`) and the server (`pnpm dev`) running, and reads
// .env.local like the server does. APP_ENV is forced to `local`, so the prod-leak guard runs and
// only a database on this machine is accepted. Staging has its own entry: tools/seed/staging.ts.
import { MongoClient } from 'mongodb';
import { loadConfig } from '../../src/config/load.js';
import { SEED_LOGINS, seedLocalWorld } from './local-world.js';

const reset = process.argv.includes('--reset');
const password = process.env.SEED_PASSWORD ?? 'switch-dev';

const env = await loadConfig({ ...process.env, APP_ENV: 'local' });
const dbHost = new URL(env.DATABASE_URI.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
if (!['localhost', '127.0.0.1'].includes(dbHost)) {
  throw new Error(
    `The seed only touches a database on this machine (DATABASE_URI host is ${dbHost}).`,
  );
}
const serverUrl = `http://localhost:${env.PORT}`;

// The server must be up: the seed goes through its REST API and cloud functions.
const deadline = Date.now() + 60_000;
for (;;) {
  const up = await fetch(`${serverUrl}/health`).then(
    (res) => res.ok,
    () => false,
  );
  if (up) break;
  if (Date.now() > deadline) throw new Error(`No server on ${serverUrl}. Start it first: pnpm dev`);
  await new Promise((r) => setTimeout(r, 500));
}

const mongo = new MongoClient(env.DATABASE_URI);
try {
  await mongo.connect();
  const db = mongo.db();
  if (reset) {
    // Documents only: `_SCHEMA` stays, because the running server caches it. The seed then
    // re-applies the schema on top, which only adds what is missing.
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) {
      if (name !== '_SCHEMA' && !name.startsWith('system.'))
        await db.collection(name).deleteMany({});
    }
    process.stdout.write(`Emptied ${collections.length - 1} local collections.\n`);
  } else if ((await db.collection('_User').countDocuments({}, { limit: 1 })) > 0) {
    process.stdout.write(
      'The local database already has data; nothing seeded (`pnpm db:reset` starts over).\n',
    );
    printLogins();
    process.exit(0);
  }
} finally {
  await mongo.close();
}

await seedLocalWorld({
  serverUrl,
  appId: env.PARSE_APP_ID,
  masterKey: env.PARSE_MASTER_KEY,
  databaseUri: env.DATABASE_URI,
  password,
});
process.stdout.write('Seeded the local world.\n');
printLogins();

function printLogins() {
  const width = Math.max(...SEED_LOGINS.map((l) => l.username.length));
  process.stdout.write(
    [
      '',
      `  Local accounts (password: ${password}):`,
      ...SEED_LOGINS.map((l) => `    ${l.username.padEnd(width)}  ${l.who}  [${l.app}]`),
      '',
    ].join('\n') + '\n',
  );
}
