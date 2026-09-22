import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv as parseDotenv } from 'node:util';
import { APP_ENVS, type AppEnv, type Env, parseEnv, SECRET_KEYS } from './env.js';
import { assertNoProdLeak } from './guards.js';
import { fetchSecretJson } from './secrets.js';

const ENV_FILES: Record<AppEnv, string> = {
  local: '.env.local',
  test: '.env.test',
  staging: '.env.staging',
  rehearsal: '.env.rehearsal',
  production: '.env.prod',
};

type Raw = Record<string, string | undefined>;

/** Reads `.env.<env>` from `cwd`. Process environment values win over the file. */
export function readEnvFile(appEnv: AppEnv, processEnv: Raw, cwd = process.cwd()): Raw {
  const file = resolve(cwd, ENV_FILES[appEnv]);
  const fromFile = existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...processEnv, APP_ENV: appEnv };
}

export function appEnvFrom(processEnv: Raw): AppEnv {
  const value = processEnv.APP_ENV;
  if (!value || !(APP_ENVS as readonly string[]).includes(value)) {
    throw new Error(`APP_ENV must be one of ${APP_ENVS.join(', ')} (got ${value ?? 'nothing'})`);
  }
  return value as AppEnv;
}

/**
 * Loading order (env doc §2.1): APP_ENV → env file → Secret Manager (staging/production) →
 * zod validation → prod-leak guard (non-production).
 */
export async function loadConfig(processEnv: Raw = process.env, cwd?: string): Promise<Env> {
  const appEnv = appEnvFrom(processEnv);
  let raw = readEnvFile(appEnv, processEnv, cwd);

  if (raw.SECRETS_SOURCE === 'gcp') {
    if (appEnv === 'production') {
      const leaked = SECRET_KEYS.filter((k) => raw[k] !== undefined);
      if (leaked.length > 0) {
        throw new Error(
          `Secrets must come from Secret Manager only; found in plain env: ${leaked.join(', ')}`,
        );
      }
    }
    if (!raw.SECRETS_PROJECT || !raw.SECRETS_VERSION || raw.SECRETS_VERSION === 'latest') {
      throw new Error('SECRETS_PROJECT and a pinned SECRETS_VERSION (not "latest") are required');
    }
    const secrets = await fetchSecretJson({
      project: raw.SECRETS_PROJECT,
      name: raw.SECRETS_NAME ?? 'switch-server-env',
      version: raw.SECRETS_VERSION,
    });
    const unknown = Object.keys(secrets).filter(
      (k) => !(SECRET_KEYS as readonly string[]).includes(k),
    );
    if (unknown.length > 0)
      throw new Error(`Unexpected keys in the secret payload: ${unknown.join(', ')}`);
    raw = { ...raw, ...secrets };
  }

  const env = parseEnv(raw);
  assertNoProdLeak(env);
  return env;
}
