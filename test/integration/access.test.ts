// setOpsAccess / setFinanceAccess and the `beforeSave _User` guard (D-22). Specs:
// switch-ops/docs/ops-access-backend.md, switch-finance/docs/finance-access-backend.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Client } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeUser, makeWorld, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
});
afterAll(() => server?.close());

const staffAccount = () => makeUser(api, { appType: ['staff'], staffType: 'Staff' });

describe.each([
  ['setOpsAccess', 'opsAccess'],
  ['setFinanceAccess', 'financeAccess'],
] as const)('%s', (name, field) => {
  it('lets an admin grant and revoke a staff account', async () => {
    const target = await staffAccount();
    const grant = await api.fn(name, { userId: target.id, granted: true }, w.staffUser.session);
    expect(grant.body.result).toEqual({ objectId: target.id, [field]: true });
    expect((await api.get('_User', target.id))![field]).toBe(true);
    const revoke = await api.fn(name, { userId: target.id, granted: false }, w.staffUser.session);
    expect(revoke.body.result).toEqual({ objectId: target.id, [field]: false });
    expect((await api.get('_User', target.id))![field]).toBe(false);
  });

  it('answers 209 without a session and 102 for bad params', async () => {
    expect((await api.fn(name, { userId: 'x', granted: true })).body.code).toBe(209);
    const s = w.staffUser.session;
    expect((await api.fn(name, { granted: true }, s)).body.code).toBe(102);
    expect((await api.fn(name, { userId: 'x', granted: 'yes' }, s)).body.code).toBe(102);
  });

  it('refuses a non-admin caller (119), even a granted staff account', async () => {
    const caller = await makeUser(api, {
      appType: ['staff'],
      staffType: 'Staff',
      opsAccess: true,
      financeAccess: true,
    });
    const target = await staffAccount();
    const res = await api.fn(name, { userId: target.id, granted: true }, caller.session);
    expect(res.body).toEqual({ code: 119, error: 'Only admins can change access.' });
    expect(
      (await api.fn(name, { userId: target.id, granted: true }, w.customer.session)).body.code,
    ).toBe(119);
  });

  it('refuses a disabled admin', async () => {
    const admin = await makeUser(api, { appType: ['staff'], staffType: 'Admin' });
    await api.update('_User', admin.id, { enabled: false });
    const target = await staffAccount();
    const res = await api.fn(name, { userId: target.id, granted: true }, admin.session);
    expect(res.body).toEqual({ code: 119, error: 'Account is disabled.' });
  });

  it('refuses a missing account (101), non-staff accounts and admins (119)', async () => {
    const s = w.staffUser.session;
    expect((await api.fn(name, { userId: 'nope', granted: true }, s)).body.code).toBe(101);
    // Customer; staffType without a staff appType; staff appType without a staffType.
    const tagged = await makeUser(api, { appType: ['driver'], staffType: 'Staff' });
    const untyped = await makeUser(api, { appType: ['staff'] });
    for (const id of [w.customer.id, tagged.id, untyped.id]) {
      const res = await api.fn(name, { userId: id, granted: true }, s);
      expect(res.body.code, id).toBe(119);
      expect((await api.get('_User', id))![field], id).toBeUndefined();
    }
    const admin = await makeUser(api, { appType: ['staff'], staffType: ' admin ' });
    const res = await api.fn(name, { userId: admin.id, granted: true }, s);
    expect(res.body).toEqual({ code: 119, error: 'Admins always have access.' });
  });
});

describe('beforeSave _User', () => {
  it.each(['opsAccess', 'financeAccess', 'staffType'])(
    'an account cannot write its own %s',
    async (field) => {
      const u = await staffAccount();
      const value = field === 'staffType' ? 'Admin' : true;
      const res = await api.request(
        'PUT',
        `/users/${u.id}`,
        { [field]: value },
        { session: u.session },
      );
      expect(res.body).toEqual({ code: 119, error: `${field} can only be changed by an admin.` });
      expect((await api.get('_User', u.id))!.staffType).toBe('Staff');
    },
  );

  it.each(['opsAccess', 'financeAccess', 'staffType'])(
    'a signup cannot carry %s',
    async (field) => {
      const value = field === 'staffType' ? 'Admin' : true;
      const res = await api.request('POST', '/users', {
        username: `forged-${field}`,
        password: 'pw',
        appType: ['staff'],
        [field]: value,
      });
      expect(res.body.code).toBe(119);
      expect(await api.find('_User', { username: `forged-${field}` })).toEqual([]);
    },
  );

  it('still lets an account write its other fields, appType included', async () => {
    const u = await staffAccount();
    const res = await api.request(
      'PUT',
      `/users/${u.id}`,
      { fullname: 'New Name', appType: ['staff', 'food'] },
      { session: u.session },
    );
    expect(res.status).toBe(200);
    expect(await api.get('_User', u.id)).toMatchObject({
      fullname: 'New Name',
      appType: ['staff', 'food'],
      staffType: 'Staff',
    });
  });

  it('leaves master-key writes alone (editUser sets staffType)', async () => {
    const u = await makeUser(api, { appType: ['driver'], fullname: 'D', email: 'd@example.test' });
    const res = await api.fn(
      'editUser',
      {
        id: u.id,
        fullname: 'D',
        email: 'd@example.test',
        phone: '0555',
        appType: ['driver', 'staff'],
        cityId: w.cityId,
        staffType: 'Staff',
      },
      w.staffUser.session,
    );
    expect(res.body.result).toBe(1);
    expect((await api.get('_User', u.id))!.staffType).toBe('Staff');
  });
});
