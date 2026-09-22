import type { Env } from './env.js';

export interface FilesAdapterLike {
  deleteFile(filename: string): Promise<unknown>;
  handleShutdown?(): Promise<unknown>;
}

export interface ParseOptionInputs {
  env: Env;
  cloud: (Parse: unknown) => void | Promise<void>;
  emailAdapter: {
    sendMail(options: { to: string; subject: string; text: string }): Promise<unknown>;
  };
  filesAdapter: FilesAdapterLike;
  /** Test-only auth adapter overrides (e.g. fake Google/Apple verifiers). Never set in staging/prod. */
  authOverrides?: Record<string, unknown>;
}

/** Express `trust proxy` value from TRUST_PROXY (comma-separated), or undefined when unset. */
export function trustProxySetting(env: Env): string[] | undefined {
  if (!env.TRUST_PROXY) return undefined;
  return env.TRUST_PROXY.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const PARSE_LOG_LEVEL: Record<Env['LOG_LEVEL'], string> = {
  fatal: 'error',
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'silly',
  silent: 'error',
};

/**
 * Parse Server 9.10 options. Every option whose default changed since 4.3 is explicit, with the
 * reason (plan §5, R7). The snapshot test in test/unit/config.test.ts pins the result.
 */
export function buildParseOptions({
  env,
  cloud,
  emailAdapter,
  filesAdapter,
  authOverrides,
}: ParseOptionInputs) {
  if (authOverrides && env.APP_ENV !== 'test')
    throw new Error('authOverrides are only allowed in APP_ENV=test');
  const serverURL = env.PARSE_SERVER_URL ?? `http://localhost:${env.PORT}`;
  return {
    appName: env.PARSE_APP_NAME,
    appId: env.PARSE_APP_ID,
    masterKey: env.PARSE_MASTER_KEY,
    // New in Parse 6; required.
    maintenanceKey: env.PARSE_MAINTENANCE_KEY,
    databaseURI: env.DATABASE_URI,
    // Internal loopback; with directAccess cloud-code SDK calls stay in-process. Legacy used the
    // public URL here, so every cloud-code query crossed the internet.
    serverURL,
    // Email links and pages.
    publicServerURL: env.PARSE_PUBLIC_SERVER_URL,
    cloud,

    // 9.x default is true; clients (finance) read other users, legacy never restricted _User reads.
    enforcePrivateUsers: false,
    // 9.x default true (legacy: false). Invisible to clients; triggers still run.
    directAccess: true,
    // 9.x default is loopback only; legacy accepted the master key from anywhere (OD-6, D-13).
    masterKeyIps: env.MASTER_KEY_IPS,
    maintenanceKeyIps: ['127.0.0.1', '::1'],
    // No `trustProxy` here: Parse applies it only in its own startApp(), which v2 doesn't use.
    // createApp sets it on the Express app instead (see trustProxySetting), so req.ip (checked
    // against masterKeyIps) is the real client behind App Engine's front end.

    allowClientClassCreation: false,
    // R4: the server never changes schema at boot. No `schema` option.
    verifyUserEmails: true,
    emailVerifyTokenValidityDuration: 48 * 60 * 60,
    preventLoginWithUnverifiedEmail: false,
    passwordPolicy: { resetTokenValidityDuration: 2 * 60 * 60 },
    emailAdapter,
    sessionLength: 31536000,
    expireInactiveSessions: true,
    protectedFields: { _User: { '*': ['email'] } },
    convertEmailToLowercase: false,
    convertUsernameToLowercase: false,
    allowCustomObjectId: false,
    preserveFileName: false,
    maxUploadSize: '20mb',
    // 9.x rejects public/anonymous uploads up front ("130 File upload by public is disabled.").
    // Legacy let everything through to beforeSaveFile, which answers `130 USER_UNAUTHENTICATED` for
    // public requests (4.3 wraps file-trigger errors in FILE_SAVE_ERROR) and accepts anonymous
    // users. Open the gate and keep the trigger as the policy. The default fileExtensions blocklist
    // stays (D-8).
    fileUpload: {
      enableForPublic: true,
      enableForAnonymousUser: true,
      enableForAuthenticatedUser: true,
      // 9.10 default, announced to become []. Legacy accepted file pointers with any URL.
      allowedFileUrlDomains: ['*'],
    },
    filesAdapter,

    // 7.0+: auth adapters are disabled unless `enabled: true`.
    auth: authOverrides ?? {
      google: { enabled: true, clientId: env.GOOGLE_CLIENT_ID },
      facebook: { enabled: true, appIds: env.FACEBOOK_APP_IDS },
      // D-3: 9.x requires clientId, so the audience is now checked (legacy checked none).
      apple: { enabled: true, clientId: env.APPLE_CLIENT_IDS },
    },
    enableInsecureAuthAdapters: false,

    databaseOptions: {
      // Since 5.0 the schema cache is per instance; without hooks a column added in Parse
      // Dashboard stays invisible to other instances until restart (needs a replica set).
      enableSchemaHooks: env.DB_ENABLE_SCHEMA_HOOKS,
      ...(env.DB_MAX_POOL_SIZE ? { maxPoolSize: env.DB_MAX_POOL_SIZE } : {}),
      ...(env.DB_MAX_TIME_MS ? { maxTimeMS: env.DB_MAX_TIME_MS } : {}),
      ...(env.DB_SERVER_SELECTION_TIMEOUT_MS
        ? { serverSelectionTimeoutMS: env.DB_SERVER_SELECTION_TIMEOUT_MS }
        : {}),
    },

    // Not used by any client; must stay off.
    startLiveQueryServer: false,
    mountGraphQL: false,

    // Defaults Parse 9.10 announces it will change. Pinned to today's (legacy-compatible) values so
    // a Parse upgrade can't silently change what clients see (R7).
    requestComplexity: {
      includeDepth: -1,
      includeCount: -1,
      subqueryDepth: -1,
      queryDepth: -1,
      graphQLDepth: -1,
      graphQLFields: -1,
      batchRequestLimit: -1,
    },
    // A user reads all of their own _User fields (incl. email), as in 4.3.
    protectedFieldsOwnerExempt: true,
    protectedFieldsTriggerExempt: false,
    protectedFieldsSaveResponseExempt: true,
    pages: { encodePageParamHeaders: false },
    installation: { duplicateDeviceTokenActionEnforceAuth: false },
    // No read-only master key is configured; restrict it anyway.
    readOnlyMasterKeyIps: ['127.0.0.1', '::1'],
    allowAggregationForReadOnlyMasterKey: false,

    security: {
      enableCheck: env.APP_ENV === 'local' || env.APP_ENV === 'staging',
      enableCheckLog: env.APP_ENV === 'local',
    },
    jsonLogs: env.APP_ENV === 'production' || env.APP_ENV === 'staging',
    logLevel: PARSE_LOG_LEVEL[env.LOG_LEVEL],
    // Parse logs the full input of every cloud function and trigger it reports on: passwords
    // (loginStaff), phone numbers, id tokens, OTP codes, user rows. Successes stay below info, and
    // failures are silenced here and logged by registerCloud without the input (plan §11, D-16).
    logLevels: {
      cloudFunctionSuccess: 'verbose',
      cloudFunctionError: 'silent',
      triggerAfter: 'verbose',
      triggerBeforeSuccess: 'verbose',
      triggerBeforeError: 'silent',
    },
    // No log files: App Engine's filesystem is read-only; stdout goes to Cloud Logging.
    logsFolder: null,
    silent: env.APP_ENV === 'test',
  };
}
