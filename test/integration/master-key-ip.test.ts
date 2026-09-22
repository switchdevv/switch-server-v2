// The master key is only accepted from MASTER_KEY_IPS. On App Engine every request reaches Node from
// the instance's serving proxy on loopback, exactly like these test requests, so the client address
// must come from CLIENT_IP_HEADER (x-appengine-user-ip), never from the socket.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({
    MASTER_KEY_IPS: '127.0.0.1,::1',
    CLIENT_IP_HEADER: 'x-appengine-user-ip',
  });
});
afterAll(() => server?.close());

const schemas = (headers: Record<string, string> = {}) =>
  fetch(`${server.url}/schemas`, {
    headers: {
      'X-Parse-Application-Id': server.appId,
      'X-Parse-Master-Key': server.masterKey,
      ...headers,
    },
  });

describe('MASTER_KEY_IPS behind App Engine', () => {
  it('refuses the master key from a loopback socket without the client IP header', async () => {
    const res = await schemas();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses the master key from an outside client IP', async () => {
    const res = await schemas({ 'X-AppEngine-User-IP': '105.235.129.17' });
    expect(res.status).toBe(403);
  });

  it('accepts the master key when the client IP is allowed', async () => {
    const res = await schemas({ 'X-AppEngine-User-IP': '127.0.0.1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('results');
  });

  it('leaves requests without the master key alone', async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
  });
});
