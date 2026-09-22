import { z } from 'zod';

/**
 * The environment schema. Every variable the server reads is declared here, and nothing else in
 * `src/` reads `process.env` (enforced by ESLint). `.env.example` documents each one.
 *
 * Keys listed in SECRET_KEYS come from Secret Manager in staging/production and must never appear
 * in a committed env file.
 */

export const APP_ENVS = ['local', 'test', 'staging', 'rehearsal', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const SECRET_KEYS = [
  'PARSE_MASTER_KEY',
  'PARSE_MAINTENANCE_KEY',
  'DATABASE_URI',
  'SENDGRID_API_KEY',
  'FIREBASE_SERVICE_ACCOUNT',
  'PUSHER_SECRET',
  'SMS_API_KEY',
  'SMS_USER_KEY',
  'GOOGLE_MAPS_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

/**
 * Production accounts staging may borrow until it has its own (SHARED_PROD_CREDENTIALS). Each stays
 * fenced by the prod-leak guard: mail and SMS only reach the allowlists, files never go to the
 * production bucket, and map lookups are read-only.
 */
export const SHAREABLE_PROD_CREDENTIALS = ['mail', 'sms', 'maps', 's3'] as const;

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const int = z.coerce.number().int().nonnegative();
const optionalInt = z.coerce.number().int().positive().optional();

export const EnvSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    PORT: int.default(1337),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Parse core
    PARSE_APP_NAME: z.string().min(1),
    PARSE_APP_ID: z.string().min(1),
    PARSE_MASTER_KEY: z.string().min(1),
    PARSE_MAINTENANCE_KEY: z.string().min(1),
    DATABASE_URI: z.string().startsWith('mongodb'),
    PARSE_PUBLIC_SERVER_URL: z.url(),
    PARSE_SERVER_URL: z.url().optional(),
    MASTER_KEY_IPS: list,
    TRUST_PROXY: z.string().optional(),
    DB_MAX_POOL_SIZE: optionalInt,
    DB_MAX_TIME_MS: optionalInt,
    DB_SERVER_SELECTION_TIMEOUT_MS: optionalInt,
    DB_ENABLE_SCHEMA_HOOKS: bool.default(true),

    // Auth adapters (public identifiers)
    GOOGLE_CLIENT_ID: z.string().min(1),
    FACEBOOK_APP_IDS: list,
    APPLE_CLIENT_IDS: list,

    // Email
    MAIL_DRIVER: z.enum(['fake', 'sendgrid', 'allowlist']),
    MAIL_FROM: z.string().min(3),
    SENDGRID_API_KEY: z.string().optional(),
    MAIL_ALLOWLIST: list,

    // Push (FCM)
    PUSH_DRIVER: z.enum(['fake', 'fcm', 'allowlist']),
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
    PUSH_TOKEN_ALLOWLIST: list,

    // Realtime (Pusher)
    REALTIME_DRIVER: z.enum(['fake', 'pusher']),
    PUSHER_APP_ID: z.string().default(''),
    PUSHER_KEY: z.string().default(''),
    PUSHER_SECRET: z.string().optional(),
    PUSHER_CLUSTER: z.string().default('eu'),

    // SMS
    SMS_DRIVER: z.enum(['fake', 'sms-algerie', 'allowlist']),
    SMS_ENDPOINT: z.url(),
    SMS_API_KEY: z.string().optional(),
    SMS_USER_KEY: z.string().optional(),
    SMS_MESSAGE_TEMPLATE: z.string().includes('%CODE%'),
    SMS_RETRIEVER_HASH_FOOD: z.string().default(''),
    SMS_RETRIEVER_HASH_DRIVER: z.string().default(''),
    SMS_RETRIEVER_HASH_MANAGER: z.string().default(''),
    SMS_PHONE_ALLOWLIST: list,

    // Distance Matrix
    DISTANCE_DRIVER: z.enum(['fake', 'google']),
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    // Files
    FILES_DRIVER: z.enum(['s3', 'gridfs']),
    S3_BUCKET: z.string().optional(),
    S3_BASE_URL: z.url().optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: bool.default(false),
    S3_CACHE_CONTROL: z.string().default('public, max-age=31536000'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // Staff bootstrap
    ADMIN_EMAIL: z.string().min(3),
    ADMIN_APP_TYPE: z.string().default('staff'),
    ADMIN_STAFF_TYPE: z.string().default('Admin'),
    STAFF_ROLE_NAME: z.string().default('Staff'),

    // Dispatch worker
    DISPATCH_WORKER_ENABLED: bool.default(true),
    AGENDA_COLLECTION: z.string().default('agendaJobs'),
    AGENDA_PROCESS_EVERY_MS: int.default(5000),
    AGENDA_LOCK_LIFETIME_MS: int.default(600000),

    // Production credentials this environment borrows (staging only)
    SHARED_PROD_CREDENTIALS: list.pipe(z.array(z.enum(SHAREABLE_PROD_CREDENTIALS))),

    // Secrets plumbing
    SECRETS_SOURCE: z.enum(['none', 'gcp']).default('none'),
    SECRETS_PROJECT: z.string().optional(),
    SECRETS_NAME: z.string().default('switch-server-env'),
    SECRETS_VERSION: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Settings whose absence would not fail at boot but would silently change behaviour.
    const need = (key: keyof typeof env, why: string) => {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `required: ${why}` });
    };
    if (env.FILES_DRIVER === 's3') {
      need('S3_BUCKET', 'FILES_DRIVER=s3');
      need('S3_ENDPOINT', 'FILES_DRIVER=s3');
      // Without it the adapter answers https://<bucket>.s3.amazonaws.com/… and every file URL breaks.
      need('S3_BASE_URL', 'FILES_DRIVER=s3 (file URLs are built from it, test F-1)');
    }
    if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') {
      if (env.FILES_DRIVER !== 's3') {
        ctx.addIssue({
          code: 'custom',
          path: ['FILES_DRIVER'],
          message: `must be s3 in ${env.APP_ENV} (file URLs)`,
        });
      }
    }
    if (env.SHARED_PROD_CREDENTIALS.length > 0 && env.APP_ENV !== 'staging') {
      ctx.addIssue({
        code: 'custom',
        path: ['SHARED_PROD_CREDENTIALS'],
        message: `only staging may borrow production credentials (APP_ENV=${env.APP_ENV})`,
      });
    }
    if (env.APP_ENV === 'production') {
      // The plain-env secret check in load.ts only runs with Secret Manager.
      if (env.SECRETS_SOURCE !== 'gcp') {
        ctx.addIssue({
          code: 'custom',
          path: ['SECRETS_SOURCE'],
          message: 'must be gcp in production',
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    // Name the variables only; values may be secrets.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return Object.freeze(result.data);
}
