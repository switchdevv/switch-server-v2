import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import { client } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';

// Everything the server logs, as parsed pino lines.
const logLines: Record<string, unknown>[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, done) {
    for (const line of chunk.toString().split('\n').filter(Boolean))
      logLines.push(JSON.parse(line) as Record<string, unknown>);
    done();
  },
});

let server: TestServer;
beforeAll(async () => {
  // The production logger config (redaction included), written to the sink.
  server = await startTestServer(
    { TRUST_PROXY: 'loopback' },
    { logger: createLogger('info', sink) },
  );
});
afterAll(() => server?.close());

describe('transport contract', () => {
  it('serves /health and the warmup route', async () => {
    const health = await fetch(server.url + '/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const warmup = await fetch(server.url + '/_ah/warmup');
    expect(warmup.status).toBe(200);
  });

  it('answers an unknown function with 141 Invalid function (switch-ops matches this text)', async () => {
    const res = await client(server).fn('noSuchFunction', {});
    expect(res.body).toEqual({ code: 141, error: 'Invalid function: "noSuchFunction"' });
  });

  it('answers a legacy error string as { code: 141, error }', async () => {
    const res = await client(server).fn('calculateOrder', {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 141, error: 'USER_UNAUTHENTICATED' });
  });
});

describe('server hardening', () => {
  it('applies TRUST_PROXY to the Express app (Parse only does it in startApp)', () => {
    expect(server.switchApp.app.get('trust proxy')).toEqual(['loopback']);
  });

  it('D-16: a failed cloud function is logged without its params', async () => {
    server.ports.script.smsResponse = { status: 'error' };
    const phoneNumber = '0555-must-not-be-logged';
    const res = await client(server).fn('verifyPhone', { phoneNumber, appType: 'food' });
    server.ports.reset();
    expect(res.body).toEqual({ code: 141, error: 'VERIFY_PHONE_ERROR' });
    expect(logLines.find((l) => l.fn === 'verifyPhone')).toMatchObject({
      msg: 'cloud function refused',
      error: 'VERIFY_PHONE_ERROR',
    });
    expect(JSON.stringify(logLines)).not.toContain(phoneNumber);
  });
});
