// `pnpm staging:secret`: adds a version of the staging secret (SECRETS_NAME in SECRETS_PROJECT,
// both from .env.staging) and pins it in .env.staging's SECRETS_VERSION. Asks only for the values
// the configured drivers need, with hidden input; Enter keeps the value of the version .env.staging
// pins (or of the latest one). The master and maintenance keys are generated (`--new-keys`
// replaces them). Nothing is sent before the result passes the server's own boot checks: the env
// schema and the prod-leak guard.
//
// Needs `gcloud auth login` with access to the secret. Values only travel on gcloud's stdin: never
// on a command line, in a file or on screen.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseEnv as parseDotenv } from 'node:util';
import { type Env, parseEnv, SECRET_KEYS } from '../src/config/env.js';
import { prodLeakProblems } from '../src/config/guards.js';

type SecretKey = (typeof SECRET_KEYS)[number];
type Payload = Partial<Record<SecretKey, string>>;

const ENV_FILE = '.env.staging';
const GENERATED: SecretKey[] = ['PARSE_MASTER_KEY', 'PARSE_MAINTENANCE_KEY'];
const HELP: Record<SecretKey, string> = {
  PARSE_MASTER_KEY: 'generated',
  PARSE_MAINTENANCE_KEY: 'generated',
  DATABASE_URI:
    'staging Atlas URI with the database name: mongodb+srv://USER:PASS@HOST/switch_staging',
  SENDGRID_API_KEY: 'SendGrid API key',
  FIREBASE_SERVICE_ACCOUNT: 'path to the staging Firebase service-account JSON file',
  PUSHER_SECRET: 'staging Pusher app secret',
  SMS_API_KEY: 'SMS Algérie apikey',
  SMS_USER_KEY: 'SMS Algérie userkey',
  GOOGLE_MAPS_API_KEY: 'Google Maps (Distance Matrix) key',
  S3_ACCESS_KEY_ID: 'Spaces access key id',
  S3_SECRET_ACCESS_KEY: 'Spaces secret key',
};

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function gcloud(args: string[], input?: string): string {
  try {
    return execFileSync('gcloud', args, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const e = error as { code?: string; stderr?: string };
    if (e.code === 'ENOENT') fail('gcloud not found: install the Google Cloud CLI first.');
    throw new Error(e.stderr?.trim() || String(error), { cause: error });
  }
}

/** Reads one line; `hidden` echoes nothing (values are secrets). */
async function ask(question: string, hidden = false): Promise<string> {
  if (!hidden) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        // Raw mode delivers Ctrl-C (3) and Backspace (127) as characters.
        if (ch.charCodeAt(0) === 3) {
          stdin.setRawMode(false);
          fail('Cancelled: nothing added.');
        }
        if (ch.charCodeAt(0) === 127 || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Host and database of a MongoDB URI (no URL parsing: seed lists have commas). */
function mongoTarget(uri: string): { host: string; database: string } {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/.exec(uri);
  return { host: m?.[1] ?? '?', database: m?.[2] ?? '' };
}

/** The secret values each driver in .env.staging needs (what the server reads at boot). */
function neededKeys(file: Record<string, string | undefined>): SecretKey[] {
  const needs: [boolean, SecretKey[]][] = [
    [true, ['PARSE_MASTER_KEY', 'PARSE_MAINTENANCE_KEY', 'DATABASE_URI']],
    [file.MAIL_DRIVER !== 'fake', ['SENDGRID_API_KEY']],
    [file.PUSH_DRIVER !== 'fake', ['FIREBASE_SERVICE_ACCOUNT']],
    [file.REALTIME_DRIVER === 'pusher', ['PUSHER_SECRET']],
    [file.SMS_DRIVER !== 'fake', ['SMS_API_KEY', 'SMS_USER_KEY']],
    [file.DISTANCE_DRIVER === 'google', ['GOOGLE_MAPS_API_KEY']],
    [file.FILES_DRIVER === 's3', ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']],
  ];
  return needs.filter(([on]) => on).flatMap(([, keys]) => keys);
}

/** A service-account JSON file, as the one-line string the server expects. */
function readServiceAccount(input: string): string {
  // Also a path dragged into the terminal: quoted, or with escaped spaces.
  const path = input
    .replace(/^(['"])(.*)\1$/, '$2')
    .replace(/\\ /g, ' ')
    .replace(/^~(?=\/)/, process.env.HOME ?? '~');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${path} is not a readable JSON file.`);
  }
  const sa = parsed as Record<string, unknown>;
  if (sa.type !== 'service_account' || !sa.project_id || !sa.private_key || !sa.client_email)
    fail(
      `${path} is not a service-account key file (Firebase → Project settings → Service accounts).`,
    );
  return JSON.stringify(sa);
}

/** Non-secret details shown next to a key so a wrong value is easy to spot. */
function describe(key: SecretKey, value: string): string {
  if (key === 'DATABASE_URI') {
    const { host, database } = mongoTarget(value);
    return ` (host ${host}, database ${database || 'none'})`;
  }
  if (key === 'FIREBASE_SERVICE_ACCOUNT') {
    const sa = JSON.parse(value) as { project_id: string; client_email: string };
    return ` (project ${sa.project_id}, ${sa.client_email})`;
  }
  return '';
}

if (!stdin.isTTY) fail('Run this in a terminal: it asks for secret values.');
const file = parseDotenv(readFileSync(ENV_FILE, 'utf8'));
const project = file.SECRETS_PROJECT;
const name = file.SECRETS_NAME || 'switch-server-env';
if (!project) fail(`Set SECRETS_PROJECT in ${ENV_FILE} to the staging project id first.`);

try {
  gcloud(['secrets', 'describe', name, `--project=${project}`, '--format=value(name)']);
} catch (error) {
  fail(
    `Can't read secret ${name} in ${project} (${(error as Error).message.split('\n')[0]}).\n` +
      '  Create it and grant access first (docs/05-staging.md, "Secret Manager").',
  );
}
const pinnedVersion = file.SECRETS_VERSION ?? '';
const baseVersion = /^[1-9]\d*$/.test(pinnedVersion) ? pinnedVersion : 'latest';
let current: Payload = {};
try {
  current = JSON.parse(
    gcloud([
      'secrets',
      'versions',
      'access',
      baseVersion,
      `--secret=${name}`,
      `--project=${project}`,
    ]),
  ) as Payload;
  console.log(`Starting from ${name} version ${baseVersion}. Enter keeps a value.\n`);
} catch {
  console.log(`${name} has no readable version yet: every value is new.\n`);
}

const newKeys = process.argv.includes('--new-keys');
const payload: Payload = {};
const status: Partial<Record<SecretKey, string>> = {};
for (const key of neededKeys(file)) {
  const had = current[key];
  if (GENERATED.includes(key)) {
    if (had && !newKeys) {
      payload[key] = had;
      status[key] = 'kept';
    } else {
      payload[key] = randomBytes(24).toString('base64url');
      status[key] = 'generated';
    }
    continue;
  }
  const hint = had ? ' [Enter keeps the current one]' : '';
  if (key === 'FIREBASE_SERVICE_ACCOUNT') {
    const path = await ask(`${key}: ${HELP[key]}${hint}\n  > `);
    if (path) payload[key] = readServiceAccount(path);
  } else {
    const value = await ask(`${key}: ${HELP[key]}${hint}\n  > `, true);
    if (value) payload[key] = value;
  }
  if (payload[key]) status[key] = had === payload[key] ? 'unchanged' : 'new';
  else if (had) {
    payload[key] = had;
    status[key] = 'kept';
  }
}

// The server's own boot checks, on exactly what it will load.
let env: Env;
try {
  env = parseEnv({ ...file, APP_ENV: 'staging', ...payload });
} catch (error) {
  fail((error as Error).message);
}
const problems = [
  ...neededKeys(file)
    .filter((key) => !payload[key])
    .map((key) => `${key} is missing (needed by the drivers in ${ENV_FILE})`),
  ...(mongoTarget(env.DATABASE_URI).database
    ? []
    : ['DATABASE_URI has no database name (…/switch_staging?…): Parse would use "test"']),
  ...prodLeakProblems(env),
];
if (problems.length > 0) fail(`Not added:\n  ${problems.join('\n  ')}`);

console.log(`\nNew version of ${name} in ${project}:`);
for (const key of neededKeys(file))
  console.log(`  ${key.padEnd(24)} ${status[key]}${describe(key, payload[key] ?? '')}`);
const ignored = Object.keys(current).filter((k) => !(k in payload));
if (ignored.length > 0) console.log(`  dropped (no driver uses them): ${ignored.join(', ')}`);
if ((await ask('\nAdd it? [y/N] ')).toLowerCase() !== 'y') fail('Nothing added.');

const added = gcloud(
  [
    'secrets',
    'versions',
    'add',
    name,
    `--project=${project}`,
    '--data-file=-',
    '--format=value(name)',
  ],
  JSON.stringify(payload),
);
const version = /\/versions\/(\d+)$/.exec(added)?.[1];
if (!version) fail(`gcloud added a version but answered "${added}"; set SECRETS_VERSION by hand.`);

const text = readFileSync(ENV_FILE, 'utf8');
writeFileSync(
  ENV_FILE,
  /^SECRETS_VERSION=.*$/m.test(text)
    ? text.replace(/^SECRETS_VERSION=.*$/m, `SECRETS_VERSION=${version}`)
    : `${text.trimEnd()}\nSECRETS_VERSION=${version}\n`,
);
console.log(
  `\n✓ Added version ${version} and set SECRETS_VERSION=${version} in ${ENV_FILE}.\n` +
    '  Commit .env.staging and push to main: the next deploy loads it. Older versions stay\n' +
    '  enabled for rollbacks; disable them once the new one is live.',
);
