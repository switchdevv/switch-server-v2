// The admin guards and switch-admin's own functions (D-24): updateConfigs and staff-account
// writes are an enabled admin's; signOutStaff, removeStaff and recountRatings are new.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Client, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeUser, makeWorld, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
});
afterAll(() => server?.close());

/** A Staff-role member, as `addUser` makes one. */
async function staffMember(fields: Record<string, unknown> = {}) {
  const user = await makeUser(api, {
    appType: ['staff'],
    staffType: 'Staff',
    city: w.city,
    ...fields,
  });
  await api.request(
    'PUT',
    `/roles/${w.staffRoleId}`,
    { users: { __op: 'AddRelation', objects: [ptr('_User', user.id)] } },
    { master: true },
  );
  return user;
}

async function inStaffRole(userId: string): Promise<boolean> {
  const members = await api.find('_User', {
    $relatedTo: { object: ptr('_Role', w.staffRoleId), key: 'users' },
  });
  return members.some((member) => member.objectId === userId);
}

const admin = () => w.staffUser.session;
const ADMIN_REQUIRED = { code: 141, error: 'ADMIN_REQUIRED' };

describe('guard A (admin)', () => {
  it('updateConfigs is refused to a non-admin Staff member, allowed to an admin', async () => {
    const staff = await staffMember();
    expect(
      (await api.fn('updateConfigs', { configs: { pickupEnabled: true } }, staff.session)).body,
    ).toEqual(ADMIN_REQUIRED);
    expect(
      (await api.fn('updateConfigs', { configs: { pickupEnabled: true } }, admin())).body,
    ).toEqual({
      result: 1,
    });
  });

  it('keeps the legacy answers for a caller with no role', async () => {
    for (const name of ['updateConfigs', 'signOutStaff', 'removeStaff', 'recountRatings']) {
      expect((await api.fn(name, {})).body, name).toEqual({
        code: 141,
        error: 'USER_UNAUTHENTICATED',
      });
      expect((await api.fn(name, {}, w.customer.session)).body, name).toEqual({
        code: 141,
        error: 'USER_UNAUTHORIZED',
      });
    }
  });

  it('refuses a disabled admin', async () => {
    const off = await staffMember({ staffType: 'Admin' });
    await api.update('_User', off.id, { enabled: false });
    expect(
      (await api.fn('updateConfigs', { configs: { pickupEnabled: true } }, off.session)).body,
    ).toEqual(ADMIN_REQUIRED);
  });

  it('addUser: a staff account is an admin’s, a driver anyone’s', async () => {
    const staff = await staffMember();
    const base = {
      password: 'secret1',
      appType: ['driver'],
      cityId: w.cityId,
      enabled: true,
      fullname: 'X',
    };
    const promote = await api.fn(
      'addUser',
      {
        ...base,
        username: 'sneaky',
        email: 'sneaky@example.test',
        appType: ['staff'],
        staffType: 'Admin',
      },
      staff.session,
    );
    expect(promote.body).toEqual(ADMIN_REQUIRED);
    expect(await api.find('_User', { username: 'sneaky' })).toHaveLength(0);

    const driver = await api.fn(
      'addUser',
      { ...base, username: 'newdriver', email: 'newdriver@example.test' },
      staff.session,
    );
    expect(driver.body).toEqual({ result: 1 });
  });

  it('editUser: a staff account, a role change or the staff app are an admin’s', async () => {
    const staff = await staffMember();
    const colleague = await staffMember();
    const edit = (id: string, extra: Record<string, unknown> = {}) =>
      api.fn(
        'editUser',
        {
          id,
          fullname: 'Edited',
          email: `${id}@example.test`,
          phone: '+213555000000',
          cityId: w.cityId,
          ...extra,
        },
        staff.session,
      );

    // Promoting themselves, or rewriting a colleague.
    expect((await edit(staff.id, { appType: ['staff'], staffType: 'Admin' })).body).toEqual(
      ADMIN_REQUIRED,
    );
    expect((await edit(colleague.id, { appType: ['staff'] })).body).toEqual(ADMIN_REQUIRED);
    expect((await api.get('_User', staff.id))!.staffType).toBe('Staff');

    // A customer, without a staffType (switch-ops' customer edit): allowed.
    expect((await edit(w.customer.id, { appType: ['food'] })).body).toEqual({ result: 1 });
    // …but not given a role or the staff app.
    expect((await edit(w.customer.id, { appType: ['food'], staffType: 'Staff' })).body).toEqual(
      ADMIN_REQUIRED,
    );
    expect((await edit(w.customer.id, { appType: ['food', 'staff'] })).body).toEqual(
      ADMIN_REQUIRED,
    );

    // An admin may do all of it.
    const res = await api.fn(
      'editUser',
      {
        id: colleague.id,
        fullname: 'Promoted',
        email: 'promoted@example.test',
        phone: '+213555000001',
        appType: ['staff'],
        cityId: w.cityId,
        staffType: 'Admin',
      },
      admin(),
    );
    expect(res.body).toEqual({ result: 1 });
    expect((await api.get('_User', colleague.id))!.staffType).toBe('Admin');
  });

  it('deleteUsers / toggleEnableUsers: a batch touching a staff account is refused whole', async () => {
    const staff = await staffMember();
    const colleague = await staffMember();
    const driver = await makeDriver(api, 91, { driverActive: false });

    expect(
      (await api.fn('toggleEnableUsers', { ids: [driver.id, colleague.id] }, staff.session)).body,
    ).toEqual(ADMIN_REQUIRED);
    expect((await api.get('_User', driver.id))!.enabled).toBe(true);
    expect((await api.fn('deleteUsers', { ids: [colleague.id] }, staff.session)).body).toEqual(
      ADMIN_REQUIRED,
    );
    expect(await api.get('_User', colleague.id)).toBeDefined();

    expect((await api.fn('toggleEnableUsers', { ids: [driver.id] }, staff.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('_User', driver.id))!.enabled).toBe(false);
    expect((await api.fn('toggleEnableUsers', { ids: [colleague.id] }, admin())).body).toEqual({
      result: 1,
    });
    expect((await api.get('_User', colleague.id))!.enabled).toBe(false);
  });
});

describe('signOutStaff', () => {
  it('ends every session of a staff account', async () => {
    const staff = await staffMember();
    expect(
      (await api.fn('getUsers', { limit: 0, skip: 0 }, staff.session)).body.result,
    ).toBeDefined();

    const res = await api.fn('signOutStaff', { userId: staff.id }, admin());
    expect(res.body.result).toEqual({ objectId: staff.id, sessions: 1 });
    expect((await api.fn('getUsers', { limit: 0, skip: 0 }, staff.session)).body.code).toBe(209);
  });

  it('refuses the caller, a non-staff account, a missing one, bad params and non-admins', async () => {
    const staff = await staffMember();
    expect((await api.fn('signOutStaff', { userId: w.staffUser.id }, admin())).body).toEqual({
      code: 141,
      error: 'SELF_NOT_ALLOWED',
    });
    expect((await api.fn('signOutStaff', { userId: w.customer.id }, admin())).body).toEqual({
      code: 141,
      error: 'NOT_STAFF_ACCOUNT',
    });
    expect((await api.fn('signOutStaff', { userId: 'nope' }, admin())).body).toEqual({
      code: 141,
      error: 'USER_DOES_NOT_EXISTS',
    });
    expect((await api.fn('signOutStaff', {}, admin())).body).toEqual({
      code: 141,
      error: 'PARAMS_MISSING',
    });
    const other = await staffMember();
    expect((await api.fn('signOutStaff', { userId: other.id }, staff.session)).body).toEqual(
      ADMIN_REQUIRED,
    );
  });
});

describe('removeStaff', () => {
  it('takes the account off the team and signs it out, keeping the account', async () => {
    const staff = await staffMember({
      appType: ['staff', 'food'],
      opsAccess: true,
      financeAccess: true,
    });
    expect(await inStaffRole(staff.id)).toBe(true);

    const res = await api.fn('removeStaff', { userId: staff.id }, admin());
    expect(res.body.result).toEqual({ objectId: staff.id, sessions: 1 });

    const row = (await api.get('_User', staff.id))!;
    expect(row.staffType).toBeUndefined();
    expect(row.opsAccess).toBeUndefined();
    expect(row.financeAccess).toBeUndefined();
    expect(row.appType).toEqual(['food']);
    expect(await inStaffRole(staff.id)).toBe(false);

    // Signed out, and a new session would no longer pass guard S.
    expect((await api.fn('getUsers', { limit: 0, skip: 0 }, staff.session)).body.code).toBe(209);
    const login = await api.request<{ sessionToken: string }>('POST', '/login', {
      username: staff.username,
      password: staff.password,
    });
    expect((await api.fn('getUsers', { limit: 0, skip: 0 }, login.body.sessionToken)).body).toEqual(
      {
        code: 141,
        error: 'USER_UNAUTHORIZED',
      },
    );
  });

  it('refuses the caller and non-admins', async () => {
    const staff = await staffMember();
    expect((await api.fn('removeStaff', { userId: w.staffUser.id }, admin())).body).toEqual({
      code: 141,
      error: 'SELF_NOT_ALLOWED',
    });
    const other = await staffMember();
    expect((await api.fn('removeStaff', { userId: other.id }, staff.session)).body).toEqual(
      ADMIN_REQUIRED,
    );
    expect(await inStaffRole(other.id)).toBe(true);
  });
});

describe('recountRatings', () => {
  it('recounts a restaurant and a driver from the reviews that are left', async () => {
    const storeId = await api.create('Restaurant', {
      name: 'Recount',
      enabled: true,
      city: w.city,
      ratingTotal: 99,
      reviews: 9,
      rating: 4.8,
    });
    const driver = await makeDriver(api, 92, { driverActive: false });
    await api.update('_User', driver.id, {
      driverParams: { ratingTotal: 50, reviews: 10, note: 'kept' },
      driverRating: 5,
    });
    // Master-key saves: `afterSave Review` returns early without a user, so nothing is added.
    for (const rating of [5, 4, 4])
      await api.create('Review', { rating, restaurant: ptr('Restaurant', storeId) });
    for (const rating of [3, 2])
      await api.create('Review', { rating, driver: ptr('_User', driver.id) });

    const res = await api.fn(
      'recountRatings',
      { restaurantIds: [storeId, 'gone'], driverIds: [driver.id] },
      admin(),
    );
    expect(res.body.result).toEqual({ restaurants: 1, drivers: 1 });
    expect(await api.get('Restaurant', storeId)).toMatchObject({
      ratingTotal: 13,
      reviews: 3,
      rating: 4.3,
    });
    expect(await api.get('_User', driver.id)).toMatchObject({
      driverRating: 2.5,
      driverParams: { ratingTotal: 5, reviews: 2, note: 'kept' },
    });
  });

  it('writes a zero rating when no review is left, and checks its params', async () => {
    const storeId = await api.create('Restaurant', {
      name: 'Empty',
      enabled: true,
      city: w.city,
      rating: 3,
      reviews: 1,
      ratingTotal: 3,
    });
    expect(
      (await api.fn('recountRatings', { restaurantIds: [storeId] }, admin())).body.result,
    ).toEqual({
      restaurants: 1,
      drivers: 0,
    });
    expect(await api.get('Restaurant', storeId)).toMatchObject({
      ratingTotal: 0,
      reviews: 0,
      rating: 0,
    });

    expect((await api.fn('recountRatings', {}, admin())).body).toEqual({
      code: 141,
      error: 'PARAMS_MISSING',
    });
    expect((await api.fn('recountRatings', { restaurantIds: 'x' }, admin())).body).toEqual({
      code: 141,
      error: 'PARAMS_MISSING',
    });
    const staff = await staffMember();
    expect(
      (await api.fn('recountRatings', { restaurantIds: [storeId] }, staff.session)).body,
    ).toEqual(ADMIN_REQUIRED);
  });
});
