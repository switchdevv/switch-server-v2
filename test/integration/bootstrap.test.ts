// loginStaff on an empty database (inventory §3.2 #22): Config, first admin, Staff role.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BOOTSTRAP_CONFIG } from '../../src/cloud/functions/staff-auth.js';
import { client, eventually } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server?.close());

it('bootstraps the admin, the Config and the Staff role, then logs in', async () => {
  const api = client(server);
  const res = await api.fn('loginStaff', { username: 'admin', password: 'first-pass' });
  expect(res.body.result).toEqual({ sessionToken: expect.stringMatching(/^r:/) });
  const [admin] = await api.find('_User', { username: 'admin' });
  expect(admin).toMatchObject({
    fullname: 'admin',
    email: 'support@switchfood.net',
    language: 'en',
    appType: ['staff'],
    staffType: 'Admin',
    enabled: true,
  });
  const config = await api.request<{ params: Record<string, unknown> }>(
    'GET',
    '/config',
    undefined,
    { master: true },
  );
  expect(config.body.params).toEqual(BOOTSTRAP_CONFIG);
  const role = await eventually(async () => (await api.find('_Role', { name: 'Staff' }))[0]);
  expect(role!.ACL).toEqual({});
  // Second call: normal path (the admin now has a role).
  const again = await api.fn('loginStaff', { username: 'admin', password: 'first-pass' });
  expect(again.body.result).toEqual({ sessionToken: expect.stringMatching(/^r:/) });
});
