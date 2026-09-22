import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { type Env, parseEnv, SECRET_KEYS } from '../../src/config/env.js';
import { fingerprint, PROD_FINGERPRINTS, prodLeakProblems } from '../../src/config/guards.js';
import { appEnvFrom, readEnvFile } from '../../src/config/load.js';
import { buildParseOptions, trustProxySetting } from '../../src/config/parse-options.js';

const testEnv = () =>
  parseEnv(readEnvFile('test', { DATABASE_URI: 'mongodb://127.0.0.1:27018/switch_test' }));
const withEnv = (patch: Record<string, string>): Env =>
  parseEnv({ ...readEnvFile('test', {}), DATABASE_URI: 'mongodb://127.0.0.1:27018/x', ...patch });

describe('env files', () => {
  it('committed env files never contain a secret key', () => {
    for (const file of ['.env.example', '.env.test', '.env.prod', '.env.staging']) {
      const values = parseDotenv(readFileSync(file, 'utf8'));
      for (const key of SECRET_KEYS) {
        if (file === '.env.test' || file === '.env.example') continue; // fake / empty placeholders
        expect(values, `${file} ${key}`).not.toHaveProperty(key);
      }
    }
    const example = parseDotenv(readFileSync('.env.example', 'utf8'));
    // Secrets are blank in the example, except the local Docker DB URI (no credentials).
    for (const key of SECRET_KEYS) {
      const value = example[key] ?? '';
      if (key === 'DATABASE_URI') expect(value).toMatch(/^mongodb:\/\/localhost:/);
      else expect(value, `${key} in .env.example`).toBe('');
    }
  });

  const prodRaw = () => ({
    ...parseDotenv(readFileSync('.env.prod', 'utf8')),
    APP_ENV: 'production',
    SECRETS_VERSION: '1',
    PARSE_MASTER_KEY: 'x',
    PARSE_MAINTENANCE_KEY: 'y',
    DATABASE_URI: 'mongodb+srv://u:p@example.invalid/switchDB',
  });

  it('.env.prod validates once the secrets are supplied, and needs no fake drivers', () => {
    const env = parseEnv(prodRaw());
    expect(env).toMatchObject({
      PARSE_APP_ID: 'switchApp',
      PARSE_PUBLIC_SERVER_URL: 'https://api.switchfood.net',
      PUSH_DRIVER: 'fcm',
      FILES_DRIVER: 's3',
      S3_BUCKET: 'switchfood',
    });
  });

  it('production refuses to boot without Secret Manager (plain-env secrets)', () => {
    expect(() => parseEnv({ ...prodRaw(), SECRETS_SOURCE: 'none' })).toThrow(/SECRETS_SOURCE/);
  });

  it('Stripe is gone: no payments settings, and none may reappear as secrets', () => {
    expect(Object.keys(parseEnv(prodRaw())).filter((k) => /STRIPE|PAYMENTS/.test(k))).toEqual([]);
    expect(SECRET_KEYS.filter((k) => k.includes('STRIPE'))).toEqual([]);
  });

  it('the S3 files driver needs bucket, endpoint and base URL; staging/production need S3', () => {
    expect(() =>
      withEnv({ FILES_DRIVER: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'http://localhost:9000' }),
    ).toThrow(/S3_BASE_URL/);
    expect(() => parseEnv({ ...prodRaw(), FILES_DRIVER: 'gridfs' })).toThrow(/FILES_DRIVER/);
  });

  it('APP_ENV must be set and known; the process env wins over the file', () => {
    expect(() => appEnvFrom({})).toThrow(/APP_ENV/);
    expect(() => appEnvFrom({ APP_ENV: 'prod' })).toThrow(/APP_ENV/);
    expect(readEnvFile('test', { PARSE_APP_NAME: 'Override' }).PARSE_APP_NAME).toBe('Override');
  });

  it('names invalid variables without printing values', () => {
    expect(() =>
      parseEnv({ ...readEnvFile('test', {}), DATABASE_URI: 'postgres://secret@host' }),
    ).toThrow(/DATABASE_URI/);
    try {
      parseEnv({ ...readEnvFile('test', {}), DATABASE_URI: 'postgres://secret@host' });
    } catch (e) {
      expect(String(e)).not.toContain('secret@host');
    }
  });
});

describe('prod-leak guard (plan §3.5)', () => {
  it('the test env is clean', () => {
    expect(prodLeakProblems(testEnv())).toEqual([]);
  });

  it('refuses production URLs, keys and real drivers outside production', () => {
    const problems = prodLeakProblems(
      withEnv({
        PARSE_PUBLIC_SERVER_URL: 'https://api.switchfood.net',
        PUSH_DRIVER: 'fcm',
        FILES_DRIVER: 's3',
        S3_BUCKET: 'switchfood',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_BASE_URL: 'http://localhost:9000/switchfood',
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PARSE_PUBLIC_SERVER_URL'),
        expect.stringContaining('PUSH_DRIVER=fcm'),
        expect.stringContaining('S3_BUCKET'),
      ]),
    );
  });

  it('recognises the production DB host by fingerprint, even with credentials and several hosts', () => {
    const env = withEnv({ DATABASE_URI: 'mongodb://u:p@a.example:27017,b.example:27017/x' });
    expect(prodLeakProblems(env)).toEqual([]);
    expect(fingerprint('a.example')).not.toBe(PROD_FINGERPRINTS.dbHost);
  });

  it('local may push through the allowlist, but not straight to FCM', () => {
    expect(prodLeakProblems(withEnv({ APP_ENV: 'local', PUSH_DRIVER: 'allowlist' }))).toEqual([]);
    expect(prodLeakProblems(withEnv({ APP_ENV: 'local', PUSH_DRIVER: 'fcm' }))).toEqual([
      expect.stringContaining('PUSH_DRIVER=fcm'),
    ]);
    expect(prodLeakProblems(withEnv({ APP_ENV: 'test', PUSH_DRIVER: 'allowlist' }))).toEqual([
      expect.stringContaining('PUSH_DRIVER=allowlist'),
    ]);
  });

  it('staging may not open the master key to every IP', () => {
    const env = withEnv({
      APP_ENV: 'staging',
      MAIL_DRIVER: 'allowlist',
      SMS_DRIVER: 'allowlist',
      FILES_DRIVER: 's3',
      S3_BUCKET: 'switchfood-staging',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BASE_URL: 'http://localhost:9000/switchfood-staging',
    });
    expect(prodLeakProblems(env)).toEqual([expect.stringContaining('MASTER_KEY_IPS')]);
  });

  it('never runs in production', () => {
    expect(prodLeakProblems({ ...testEnv(), APP_ENV: 'production', PUSH_DRIVER: 'fcm' })).toEqual(
      [],
    );
  });
});

describe('staging (docs/05-staging.md)', () => {
  // Stand-ins for the production values: the guard only knows their fingerprints, so the tests
  // swap in fingerprints of these fakes.
  const PROD = {
    smsUserKey: 'prod-sms-user-key',
    smsApiKey: 'prod-sms-api-key',
    spacesKeyId: 'prod-spaces-key-id',
    sendgridKey: 'SG.prod-sendgrid-key',
    mapsKey: 'prod-maps-key',
    dbHost: 'prod-cluster.example.net',
  };
  const fps = {
    ...PROD_FINGERPRINTS,
    smsUserKey: fingerprint(PROD.smsUserKey),
    smsApiKey: fingerprint(PROD.smsApiKey),
    spacesKeyId: fingerprint(PROD.spacesKeyId),
    sendgridKey: fingerprint(PROD.sendgridKey),
    mapsKey: fingerprint(PROD.mapsKey),
    dbHost: fingerprint(PROD.dbHost),
  };
  const firebase = (projectId: string) =>
    JSON.stringify({ type: 'service_account', project_id: projectId, private_key_id: 'k1' });
  const stagingFile = () => parseDotenv(readFileSync('.env.staging', 'utf8'));
  /** `.env.staging` plus a secret payload of staging's own credentials. */
  const stagingRaw = (patch: Record<string, string> = {}) => ({
    ...stagingFile(),
    APP_ENV: 'staging',
    SECRETS_VERSION: '1',
    PARSE_MASTER_KEY: 'staging-master',
    PARSE_MAINTENANCE_KEY: 'staging-maintenance',
    DATABASE_URI: 'mongodb+srv://u:p@switch-staging.abcde.mongodb.net/switch_staging',
    FIREBASE_SERVICE_ACCOUNT: firebase('switch-staging'),
    PUSHER_SECRET: 'staging-pusher-secret',
    SENDGRID_API_KEY: 'SG.staging-sendgrid-key',
    SMS_API_KEY: 'staging-sms-api-key',
    SMS_USER_KEY: 'staging-sms-user-key',
    GOOGLE_MAPS_API_KEY: 'staging-maps-key',
    S3_ACCESS_KEY_ID: 'staging-spaces-key-id',
    S3_SECRET_ACCESS_KEY: 'staging-spaces-secret',
    ...patch,
  });
  /** The production keys of each borrowed account, as the staging secret carries them. */
  const PROD_KEYS: Record<string, Record<string, string>> = {
    mail: { SENDGRID_API_KEY: PROD.sendgridKey },
    sms: { SMS_API_KEY: PROD.smsApiKey, SMS_USER_KEY: PROD.smsUserKey },
    maps: { GOOGLE_MAPS_API_KEY: PROD.mapsKey },
    s3: { S3_ACCESS_KEY_ID: PROD.spacesKeyId },
  };
  const prodKeysOf = (names: string[]) =>
    names.reduce<Record<string, string>>((all, n) => ({ ...all, ...PROD_KEYS[n] }), {});
  const borrowing = (names: string[]) => ({
    SHARED_PROD_CREDENTIALS: names.join(','),
    MAIL_DRIVER: 'allowlist',
    SMS_DRIVER: 'allowlist',
    S3_BUCKET: 'switchfood-staging',
    ...prodKeysOf(names),
  });

  it('.env.staging validates with its secrets and passes the guard, borrowed keys included', () => {
    const shared = (stagingFile().SHARED_PROD_CREDENTIALS ?? '').split(',').filter(Boolean);
    const env = parseEnv(stagingRaw(prodKeysOf(shared)));
    expect(env).toMatchObject({ APP_ENV: 'staging', FILES_DRIVER: 's3', SECRETS_SOURCE: 'gcp' });
    expect(prodLeakProblems(env, fps)).toEqual([]);
  });

  it('accepts the production mail, SMS, maps and Spaces keys while staging borrows them', () => {
    const env = parseEnv(stagingRaw(borrowing(['mail', 'sms', 'maps', 's3'])));
    expect(env.SHARED_PROD_CREDENTIALS).toEqual(['mail', 'sms', 'maps', 's3']);
    expect(prodLeakProblems(env, fps)).toEqual([]);
  });

  it('refuses the production keys once staging stops sharing them', () => {
    const env = parseEnv(
      stagingRaw({ ...borrowing(['mail', 'sms', 'maps', 's3']), SHARED_PROD_CREDENTIALS: '' }),
    );
    expect(prodLeakProblems(env, fps)).toEqual([
      'SMS credentials are the production ones',
      'S3_ACCESS_KEY_ID is the production Spaces key',
      'SENDGRID_API_KEY is the production key',
      'GOOGLE_MAPS_API_KEY is the production key',
    ]);
  });

  it('keeps every shared account behind its fence', () => {
    const env = parseEnv(
      stagingRaw({
        ...borrowing(['mail', 'sms', 'maps', 's3']),
        MAIL_DRIVER: 'sendgrid',
        SMS_DRIVER: 'sms-algerie',
        S3_BUCKET: 'switchfood',
      }),
    );
    expect(prodLeakProblems(env, fps)).toEqual([
      'S3_BUCKET is the production bucket',
      'MAIL_DRIVER must be allowlist while staging shares the production mail account',
      'SMS_DRIVER must be allowlist while staging shares the production SMS account',
    ]);
  });

  it('shares nothing else: production database, URL and Firebase project stay refused', () => {
    const env = parseEnv(
      stagingRaw({
        ...borrowing(['mail', 'sms', 'maps', 's3']),
        PUSH_DRIVER: 'fcm',
        DATABASE_URI: `mongodb+srv://u:p@${PROD.dbHost}/switchDB`,
        PARSE_PUBLIC_SERVER_URL: 'https://staging-api.switchfood.net',
        FIREBASE_SERVICE_ACCOUNT: firebase('switch-proj'),
      }),
    );
    expect(prodLeakProblems(env, fps)).toEqual([
      'DATABASE_URI points at the production cluster',
      'PARSE_PUBLIC_SERVER_URL points at switchfood.net',
      'the production Firebase project may only be used through PUSH_DRIVER=allowlist (OD-7)',
    ]);
  });

  it('only staging may borrow production accounts, and only the known ones', () => {
    for (const APP_ENV of ['local', 'test', 'rehearsal']) {
      expect(() => withEnv({ APP_ENV, SHARED_PROD_CREDENTIALS: 'sms' })).toThrow(
        /SHARED_PROD_CREDENTIALS: only staging/,
      );
    }
    expect(() =>
      parseEnv({
        ...parseDotenv(readFileSync('.env.prod', 'utf8')),
        APP_ENV: 'production',
        SECRETS_VERSION: '1',
        PARSE_MASTER_KEY: 'x',
        PARSE_MAINTENANCE_KEY: 'y',
        DATABASE_URI: 'mongodb+srv://u:p@example.invalid/switchDB',
        SHARED_PROD_CREDENTIALS: 'mail',
      }),
    ).toThrow(/SHARED_PROD_CREDENTIALS/);
    expect(() => parseEnv(stagingRaw({ SHARED_PROD_CREDENTIALS: 'mail,firebase' }))).toThrow(
      /SHARED_PROD_CREDENTIALS/,
    );
  });
});

describe('Parse Server options (plan §5, R7)', () => {
  const options = buildParseOptions({
    env: testEnv(),
    cloud: () => undefined,
    emailAdapter: { sendMail: () => Promise.resolve() },
    filesAdapter: { deleteFile: () => Promise.resolve() },
  });

  it('pins every option whose default changed since 4.3', () => {
    expect(options).toMatchObject({
      enforcePrivateUsers: false,
      directAccess: true,
      allowClientClassCreation: false,
      verifyUserEmails: true,
      emailVerifyTokenValidityDuration: 172800,
      preventLoginWithUnverifiedEmail: false,
      passwordPolicy: { resetTokenValidityDuration: 7200 },
      sessionLength: 31536000,
      expireInactiveSessions: true,
      protectedFields: { _User: { '*': ['email'] } },
      convertEmailToLowercase: false,
      convertUsernameToLowercase: false,
      maxUploadSize: '20mb',
      fileUpload: {
        enableForPublic: true,
        enableForAnonymousUser: true,
        enableForAuthenticatedUser: true,
        allowedFileUrlDomains: ['*'],
      },
      auth: {
        google: { enabled: true, clientId: 'test-google-client-id.apps.googleusercontent.com' },
        facebook: { enabled: true, appIds: ['1234567890'] },
        apple: {
          enabled: true,
          clientId: ['com.switchapp.food', 'com.switchapp.driver', 'com.switchapp.manager'],
        },
      },
      enableInsecureAuthAdapters: false,
      startLiveQueryServer: false,
      mountGraphQL: false,
      protectedFieldsOwnerExempt: true,
      logsFolder: null,
    });
    expect(options).not.toHaveProperty('schema');
    expect(options).not.toHaveProperty('push');
  });

  it('keeps the snapshot (update only with a Deviation Register entry)', () => {
    const { cloud: _c, emailAdapter: _e, filesAdapter: _f, ...plain } = options;
    expect(plain).toMatchSnapshot();
  });

  it('trust proxy comes from TRUST_PROXY (applied by createApp, not by Parse)', () => {
    expect(options).not.toHaveProperty('trustProxy');
    expect(trustProxySetting(testEnv())).toBeUndefined();
    expect(trustProxySetting(withEnv({ TRUST_PROXY: ' 1 , loopback ' }))).toEqual([
      '1',
      'loopback',
    ]);
  });

  it('Parse never logs cloud-function or before-trigger inputs (D-16)', () => {
    expect(options.logLevels).toMatchObject({
      cloudFunctionError: 'silent',
      triggerBeforeError: 'silent',
    });
  });

  it('refuses test auth overrides outside APP_ENV=test', () => {
    expect(() =>
      buildParseOptions({
        env: { ...testEnv(), APP_ENV: 'local' },
        cloud: () => undefined,
        emailAdapter: { sendMail: () => Promise.resolve() },
        filesAdapter: { deleteFile: () => Promise.resolve() },
        authOverrides: {},
      }),
    ).toThrow();
  });
});
