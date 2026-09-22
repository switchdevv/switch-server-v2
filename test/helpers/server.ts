import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Parse from 'parse/node';
import { inject } from 'vitest';
import { createApp, type SwitchApp } from '../../src/app.js';
import { createFakePorts, type FakePorts } from '../../src/adapters/fakes.js';
import type { Random } from '../../src/cloud/context.js';
import { parseEnv } from '../../src/config/env.js';
import { readEnvFile } from '../../src/config/load.js';
import { createLogger, type Logger } from '../../src/observability/logger.js';

/** Deterministic randomness for tests. */
export function testRandom(): Random & { reset(): void } {
  let n = 0;
  return {
    otp: () => '4321',
    notifId: () => String(10000000 + ++n),
    password: () => `pw${++n}xyz`.slice(-8),
    reset: () => {
      n = 0;
    },
  };
}

/**
 * Fake auth adapter: accepts any token whose value is `valid:<id>` for that id. Parse's real
 * Google/Apple adapters verify JWTs against the providers' keys; that path is Parse's own code and
 * is exercised with real tokens in staging (P4-4).
 */
export function fakeAuthAdapter() {
  const check = (authData: Record<string, unknown>) => {
    const token = authData.id_token ?? authData.token ?? authData.access_token;
    // Like Parse's real adapters: OBJECT_NOT_FOUND (101) for a token that doesn't verify.
    if (token !== `valid:${String(authData.id)}`)
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'fake auth: invalid token');
  };
  return {
    validateAuthData: (authData: Record<string, unknown>) => {
      check(authData);
      return Promise.resolve();
    },
    validateAppId: () => Promise.resolve(),
  };
}

export interface TestServer {
  url: string;
  appId: string;
  masterKey: string;
  switchApp: SwitchApp;
  ports: FakePorts;
  random: ReturnType<typeof testRandom>;
  clock: { now: Date | undefined };
  close(): Promise<void>;
}

let dbCounter = 0;

export async function startTestServer(
  envOverrides: Record<string, string> = {},
  opts: { logger?: Logger } = {},
): Promise<TestServer> {
  const dbName = `switch_test_${process.pid}_${++dbCounter}`;
  const base = new URL(inject('mongoUri'));
  base.pathname = `/${dbName}`;
  const raw = readEnvFile('test', {
    DATABASE_URI: base.toString(),
    ...envOverrides,
  });
  const env = parseEnv(raw);
  const ports = createFakePorts();
  const random = testRandom();
  const clock: { now: Date | undefined } = { now: undefined };
  const fake = fakeAuthAdapter();
  const switchApp = await createApp(env, {
    ports,
    random,
    logger: opts.logger ?? createLogger('silent'),
    now: () => clock.now ?? new Date(),
    authOverrides: {
      google: { enabled: true, module: fake },
      apple: { enabled: true, module: fake },
      facebook: { enabled: true, module: fake },
    },
  });
  const server: Server = createServer(switchApp.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  switchApp.attach(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    appId: env.PARSE_APP_ID,
    masterKey: env.PARSE_MASTER_KEY,
    switchApp,
    ports,
    random,
    clock,
    close: () => switchApp.close(),
  };
}
