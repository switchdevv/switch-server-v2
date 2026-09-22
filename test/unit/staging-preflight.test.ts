import { describe, expect, it } from 'vitest';
import { stagingProblems } from '../../tools/deploy/staging-preflight.js';

describe('staging deploy preflight (tools/deploy/staging-preflight.ts)', () => {
  const facts = {
    project: 'switch-staging',
    hostname: 'switch-staging.ew.r.appspot.com',
    secretState: 'ENABLED',
  };
  const ready = {
    SECRETS_SOURCE: 'gcp',
    SECRETS_PROJECT: 'switch-staging',
    SECRETS_VERSION: '3',
    PARSE_PUBLIC_SERVER_URL: 'https://switch-staging.ew.r.appspot.com',
    REALTIME_DRIVER: 'pusher',
    PUSHER_APP_ID: '1234567',
    PUSHER_KEY: 'staging-pusher-key',
  };

  it('lets a .env.staging that matches the project through', () => {
    expect(stagingProblems(ready, facts)).toEqual([]);
    expect(
      stagingProblems(
        { ...ready, PARSE_PUBLIC_SERVER_URL: `${ready.PARSE_PUBLIC_SERVER_URL}/` },
        facts,
      ),
    ).toEqual([]);
  });

  it('names each value a fresh setup still has to fill in, with the value to use', () => {
    const problems = stagingProblems(
      {
        ...ready,
        SECRETS_PROJECT: 'someone-else',
        SECRETS_VERSION: '',
        PARSE_PUBLIC_SERVER_URL: 'https://switch-staging.example.invalid',
        PUSHER_APP_ID: '',
      },
      { ...facts, secretState: undefined },
    );
    expect(problems).toEqual([
      expect.stringContaining('set SECRETS_PROJECT=switch-staging'),
      expect.stringContaining('SECRETS_VERSION is not set'),
      expect.stringContaining(
        'set PARSE_PUBLIC_SERVER_URL=https://switch-staging.ew.r.appspot.com',
      ),
      expect.stringContaining('PUSHER_APP_ID and PUSHER_KEY'),
    ]);
  });

  it('refuses a secret version that is missing, disabled or not a pinned number', () => {
    expect(stagingProblems(ready, { ...facts, secretState: undefined })).toEqual([
      'secret switch-server-env version 3 is missing in switch-staging',
    ]);
    expect(stagingProblems(ready, { ...facts, secretState: 'DISABLED' })).toEqual([
      'secret switch-server-env version 3 is disabled in switch-staging',
    ]);
    for (const SECRETS_VERSION of ['latest', '0', '2.1'])
      expect(stagingProblems({ ...ready, SECRETS_VERSION }, facts)).toEqual([
        expect.stringContaining('SECRETS_VERSION is not set'),
      ]);
  });

  it('refuses a public URL with a path, over http, or on another host', () => {
    for (const PARSE_PUBLIC_SERVER_URL of [
      'https://switch-staging.ew.r.appspot.com/parse',
      'http://switch-staging.ew.r.appspot.com',
      'https://staging.example.com',
      'not a url',
    ])
      expect(stagingProblems({ ...ready, PARSE_PUBLIC_SERVER_URL }, facts)).toEqual([
        expect.stringContaining('PARSE_PUBLIC_SERVER_URL'),
      ]);
  });

  it('needs Secret Manager, and Pusher ids only when Pusher is on', () => {
    expect(stagingProblems({ ...ready, SECRETS_SOURCE: 'none' }, facts)).toEqual([
      'SECRETS_SOURCE must be gcp',
    ]);
    expect(
      stagingProblems(
        { ...ready, REALTIME_DRIVER: 'fake', PUSHER_APP_ID: '', PUSHER_KEY: '' },
        facts,
      ),
    ).toEqual([]);
  });
});
