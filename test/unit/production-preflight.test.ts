import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { productionProblems } from '../../tools/deploy/production-preflight.js';

describe('production deploy preflight (tools/deploy/production-preflight.ts)', () => {
  const facts = {
    project: 'switch-proj',
    mappedDomains: ['api.switchfood.net', 'switchfood.net'],
    secretState: 'ENABLED',
  };
  const ready = {
    SECRETS_SOURCE: 'gcp',
    SECRETS_PROJECT: 'switch-proj',
    SECRETS_VERSION: '4',
    PARSE_PUBLIC_SERVER_URL: 'https://api.switchfood.net',
    CLIENT_IP_HEADER: 'x-appengine-user-ip',
    REALTIME_DRIVER: 'pusher',
    PUSHER_APP_ID: '1234567',
    PUSHER_KEY: 'production-pusher-key',
  };

  it('lets a .env.prod that matches the project serving api.switchfood.net through', () => {
    expect(productionProblems(ready, facts)).toEqual([]);
    expect(
      productionProblems(
        { ...ready, PARSE_PUBLIC_SERVER_URL: 'https://api.switchfood.net/' },
        facts,
      ),
    ).toEqual([]);
  });

  it('refuses a project that does not serve api.switchfood.net', () => {
    expect(
      productionProblems(
        { ...ready, SECRETS_PROJECT: 'switchfood-staging' },
        { ...facts, project: 'switchfood-staging', mappedDomains: [] },
      ),
    ).toEqual([expect.stringContaining('api.switchfood.net is not mapped to switchfood-staging')]);
  });

  it('names each value a fresh setup still has to fill in', () => {
    const problems = productionProblems(
      {
        ...ready,
        SECRETS_PROJECT: 'someone-else',
        SECRETS_VERSION: '',
        CLIENT_IP_HEADER: '',
        PUSHER_APP_ID: '',
      },
      { ...facts, secretState: undefined },
    );
    expect(problems).toEqual([
      expect.stringContaining('set SECRETS_PROJECT=switch-proj'),
      expect.stringContaining('SECRETS_VERSION is not set'),
      'CLIENT_IP_HEADER must be x-appengine-user-ip',
      expect.stringContaining('PUSHER_APP_ID and PUSHER_KEY'),
    ]);
  });

  it('refuses a secret version that is missing, disabled or not a pinned number', () => {
    expect(productionProblems(ready, { ...facts, secretState: undefined })).toEqual([
      'secret switch-server-env version 4 is missing in switch-proj',
    ]);
    expect(productionProblems(ready, { ...facts, secretState: 'DESTROYED' })).toEqual([
      'secret switch-server-env version 4 is destroyed in switch-proj',
    ]);
    for (const SECRETS_VERSION of ['latest', '0', '2.1'])
      expect(productionProblems({ ...ready, SECRETS_VERSION }, facts)).toEqual([
        expect.stringContaining('SECRETS_VERSION is not set'),
      ]);
  });

  it('refuses any public URL but https://api.switchfood.net', () => {
    for (const PARSE_PUBLIC_SERVER_URL of [
      'https://switch-proj.ew.r.appspot.com',
      'http://api.switchfood.net',
      'https://api.switchfood.net/parse',
      'not a url',
    ])
      expect(productionProblems({ ...ready, PARSE_PUBLIC_SERVER_URL }, facts)).toEqual([
        expect.stringContaining('PARSE_PUBLIC_SERVER_URL'),
      ]);
  });

  it("refuses staging's borrowed-credentials list and plain-env secrets", () => {
    expect(productionProblems({ ...ready, SHARED_PROD_CREDENTIALS: 'mail' }, facts)).toEqual([
      expect.stringContaining('SHARED_PROD_CREDENTIALS is staging-only'),
    ]);
    expect(productionProblems({ ...ready, SECRETS_SOURCE: 'none' }, facts)).toEqual([
      'SECRETS_SOURCE must be gcp',
    ]);
  });

  it('the committed .env.prod only lacks what the setup fills in', () => {
    const committed = parseDotenv(readFileSync('.env.prod', 'utf8'));
    const problems = productionProblems(committed, { ...facts, secretState: undefined });
    for (const p of problems)
      expect(p).toMatch(/SECRETS_VERSION is not set|PUSHER_APP_ID and PUSHER_KEY/);
  });
});
