import { createHash } from 'node:crypto';
import type { Env } from './env.js';

/**
 * Prod-leak guard (plan §3.5). Runs before anything connects anywhere, in every environment
 * except `production`, and refuses to boot when any value points at production. The one exception
 * is staging's SHARED_PROD_CREDENTIALS: the production mail, SMS, maps and Spaces accounts it
 * borrows until it has its own, each only behind its staging fence.
 *
 * Fingerprints are the first 16 hex chars of SHA-256 over production identifiers. They were
 * computed from the legacy `configs.js` (hashes only; see tools/fingerprint.mjs) and let us
 * recognise a production value without committing it.
 */
export const PROD_FINGERPRINTS = {
  dbHost: '7292e52f65166967',
  masterKey: '5a3cd0121c039a4a',
  smsUserKey: '7768b9bc80032e55',
  smsApiKey: 'ff44f59f629a4c93',
  spacesKeyId: '8e6b339892d6149b',
  sendgridKey: '10b896cc322c2bbd',
  mapsKey: '705cfbb129cd3317',
  firebasePrivateKeyId: '394b96e0a8095781',
} as const;

/** Production identifiers that are public by nature, so they are compared in the clear. */
export const PROD_PUBLIC = {
  hostSuffix: 'switchfood.net',
  firebaseProjectId: 'switch-proj',
  bucket: 'switchfood',
} as const;

export const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

function dbHosts(uri: string): string[] {
  // mongodb://h1:p,h2:p/db or mongodb+srv://host/db, optionally with user:pass@
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const authority = afterScheme.split('/')[0] ?? '';
  const hosts = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  return hosts
    .split(',')
    .map((h) => h.replace(/:\d+$/, '').toLowerCase())
    .filter(Boolean);
}

function firebaseIdentity(json: string | undefined): { projectId?: string; privateKeyId?: string } {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as { project_id?: unknown; private_key_id?: unknown };
    return {
      projectId: typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
      privateKeyId: typeof parsed.private_key_id === 'string' ? parsed.private_key_id : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Returns the reasons boot must be refused. Empty means safe. `fingerprints` is only replaced in
 * tests, which can't hold a real production value to match against.
 */
export function prodLeakProblems(
  env: Env,
  fingerprints: Record<keyof typeof PROD_FINGERPRINTS, string> = PROD_FINGERPRINTS,
): string[] {
  if (env.APP_ENV === 'production') return [];
  const problems: string[] = [];
  const is = (value: string | undefined, fp: string) => !!value && fingerprint(value) === fp;
  // Production accounts staging borrows on purpose (the env schema refuses the list elsewhere).
  // Each is only accepted behind its staging fence, checked below.
  const shared = new Set(env.APP_ENV === 'staging' ? env.SHARED_PROD_CREDENTIALS : []);

  if (dbHosts(env.DATABASE_URI).some((h) => fingerprint(h) === fingerprints.dbHost)) {
    problems.push('DATABASE_URI points at the production cluster');
  }
  if (is(env.PARSE_MASTER_KEY, fingerprints.masterKey)) {
    problems.push('PARSE_MASTER_KEY is the production master key');
  }
  for (const key of ['PARSE_PUBLIC_SERVER_URL', 'PARSE_SERVER_URL'] as const) {
    const value = env[key];
    if (value && new URL(value).hostname.endsWith(PROD_PUBLIC.hostSuffix)) {
      problems.push(`${key} points at ${PROD_PUBLIC.hostSuffix}`);
    }
  }
  if (
    !shared.has('sms') &&
    (is(env.SMS_USER_KEY, fingerprints.smsUserKey) || is(env.SMS_API_KEY, fingerprints.smsApiKey))
  ) {
    problems.push('SMS credentials are the production ones');
  }
  if (!shared.has('s3') && is(env.S3_ACCESS_KEY_ID, fingerprints.spacesKeyId)) {
    problems.push('S3_ACCESS_KEY_ID is the production Spaces key');
  }
  // Even with the production Spaces key, never the production bucket: staging deletes files.
  if (env.FILES_DRIVER === 's3' && env.S3_BUCKET === PROD_PUBLIC.bucket) {
    problems.push('S3_BUCKET is the production bucket');
  }
  if (!shared.has('mail') && is(env.SENDGRID_API_KEY, fingerprints.sendgridKey)) {
    problems.push('SENDGRID_API_KEY is the production key');
  }
  if (!shared.has('maps') && is(env.GOOGLE_MAPS_API_KEY, fingerprints.mapsKey)) {
    problems.push('GOOGLE_MAPS_API_KEY is the production key');
  }
  // A shared account may only reach the staging allowlists, whichever key is loaded.
  if (shared.has('mail') && env.MAIL_DRIVER !== 'allowlist') {
    problems.push('MAIL_DRIVER must be allowlist while staging shares the production mail account');
  }
  if (shared.has('sms') && env.SMS_DRIVER !== 'allowlist') {
    problems.push('SMS_DRIVER must be allowlist while staging shares the production SMS account');
  }
  const firebase = firebaseIdentity(env.FIREBASE_SERVICE_ACCOUNT);
  if (is(firebase.privateKeyId, fingerprints.firebasePrivateKeyId)) {
    problems.push('FIREBASE_SERVICE_ACCOUNT is the production service-account key');
  }
  if (
    firebase.projectId === PROD_PUBLIC.firebaseProjectId &&
    env.PUSH_DRIVER !== 'allowlist' &&
    env.PUSH_DRIVER !== 'fake'
  ) {
    problems.push(
      'the production Firebase project may only be used through PUSH_DRIVER=allowlist (OD-7)',
    );
  }

  // local / test / rehearsal never talk to real providers. Exception: local may push through
  // the allowlist, so a laptop can reach the developer's own devices with the staging key.
  if (env.APP_ENV === 'local' || env.APP_ENV === 'test' || env.APP_ENV === 'rehearsal') {
    const localAllowlistPush = env.APP_ENV === 'local' && env.PUSH_DRIVER === 'allowlist';
    const real = (
      [
        ['MAIL_DRIVER', env.MAIL_DRIVER],
        ['PUSH_DRIVER', localAllowlistPush ? 'fake' : env.PUSH_DRIVER],
        // ['REALTIME_DRIVER', env.REALTIME_DRIVER],
        ['SMS_DRIVER', env.SMS_DRIVER],
        ['DISTANCE_DRIVER', env.DISTANCE_DRIVER],
      ] as const
    ).filter(([, v]) => v !== 'fake');
    for (const [k, v] of real)
      problems.push(`${k}=${v} is not allowed in ${env.APP_ENV} (fake only)`);
  }

  // Master key from anywhere is only acceptable on a laptop / in tests (plan OD-6).
  if (env.APP_ENV === 'staging' || env.APP_ENV === 'rehearsal') {
    if (env.MASTER_KEY_IPS.some((ip) => ip === '0.0.0.0/0' || ip === '::/0')) {
      problems.push(`MASTER_KEY_IPS may not be open to every address in ${env.APP_ENV}`);
    }
    // Behind App Engine's proxy the socket address is loopback for every request (see app.ts).
    if (!env.CLIENT_IP_HEADER && !env.TRUST_PROXY) {
      problems.push(
        `CLIENT_IP_HEADER must be set in ${env.APP_ENV}: without it every request comes from loopback and MASTER_KEY_IPS lets it in`,
      );
    }
  }
  return problems;
}

export function assertNoProdLeak(env: Env): void {
  const problems = prodLeakProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to boot APP_ENV=${env.APP_ENV}: production values detected.\n  ${problems.join('\n  ')}`,
    );
  }
}
