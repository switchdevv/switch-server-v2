// Staff functions (switch-dashboard, switch-ops): inventory §3.2 #23–#50, plus the catalogue triggers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeUser, makeWorld, placeOrder, type World } from '../helpers/world.js';

/** A saved file as clients send it (with its URL). */
const file = (name: string) => ({
  __type: 'File',
  name,
  url: `http://localhost:1337/files/switchApp/${name}`,
});

let server: TestServer;
let api: Client;
let w: World;

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await api.request(
    'PUT',
    '/config',
    { params: { driverRealtime: false, sendNotifsToAll: false } },
    { master: true },
  );
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

const staff = (name: string, params: Record<string, unknown> = {}) =>
  api.fn(name, params, w.staffUser.session);

describe('guard S', () => {
  const STAFF_FUNCTIONS = [
    'updateConfigs',
    'getUsers',
    'addUser',
    'editUser',
    'deleteUsers',
    'toggleEnableUsers',
    'deleteMessages',
    'editPromo',
    'assignPromo',
    'deletePromos',
    'deleteStores',
    'toggleEnableStores',
    'assignManager',
    'assignStoreFile',
    'changeRegion',
    'editList',
    'assignList',
    'deletelists',
    'editProduct',
    'assignProduct',
    'deleteProducts',
    'duplicateProduct',
    'deleteReviews',
    'deleteOrders',
    'editOrder',
    'assignDriver',
    'chooseDriver',
    'sendPush',
  ];
  it.each(STAFF_FUNCTIONS)(
    '%s: USER_UNAUTHENTICATED without a session, USER_UNAUTHORIZED without a role',
    async (name) => {
      expect((await api.fn(name, {})).body).toEqual({ code: 141, error: 'USER_UNAUTHENTICATED' });
      expect((await api.fn(name, {}, w.customer.session)).body).toEqual({
        code: 141,
        error: 'USER_UNAUTHORIZED',
      });
    },
  );

  it('checks the role before params (PARAMS_MISSING only for staff)', async () => {
    expect((await staff('getUsers', {})).body.error).toBe('PARAMS_MISSING');
  });
});

describe('loginStaff', () => {
  it('USER_DOES_NOT_EXISTS / USER_UNAUTHORIZED / 101 / session', async () => {
    expect((await api.fn('loginStaff', { username: 'x' })).body.error).toBe(
      'LOGIN_STAFF_PARAMS_MISSING',
    );
    expect((await api.fn('loginStaff', { username: 'ghost', password: 'x' })).body.error).toBe(
      'USER_DOES_NOT_EXISTS',
    );
    expect(
      (await api.fn('loginStaff', { username: w.customer.username, password: w.customer.password }))
        .body.error,
    ).toBe('USER_UNAUTHORIZED');
    const wrong = await api.fn('loginStaff', { username: w.staffUser.username, password: 'nope' });
    expect(wrong.body.code).toBe(101);
    const ok = await api.fn('loginStaff', {
      username: w.staffUser.username,
      password: w.staffUser.password,
    });
    expect(ok.body.result).toEqual({ sessionToken: expect.stringMatching(/^r:[A-Za-z0-9]+$/) });
  });

  it('beforeLogin: a disabled staff user gets 141 ACCOUNT_INACTIVE', async () => {
    const off = await makeUser(api, { appType: ['staff'], staffType: 'Staff', enabled: false });
    await api.request(
      'PUT',
      `/roles/${w.staffRoleId}`,
      { users: { __op: 'AddRelation', objects: [ptr('_User', off.id)] } },
      { master: true },
    );
    expect(
      (await api.fn('loginStaff', { username: off.username, password: off.password })).body,
    ).toEqual({ code: 141, error: 'ACCOUNT_INACTIVE' });
  });
});

describe('users', () => {
  it('getUsers: filters, includes, counts and returns toJSON() rows', async () => {
    const res = await staff('getUsers', { limit: 10, skip: 0, appType: 'manager' });
    const result = res.body.result as { count: number; results: Record<string, unknown>[] };
    expect(result.count).toBe(1);
    expect(result.results[0]).toMatchObject({
      objectId: w.manager.id,
      email: expect.any(String), // master key: protected fields included
      managerStore: {
        __type: 'Object',
        className: 'Restaurant',
        objectId: w.storeId,
        name: 'Chez Test',
      },
      city: { __type: 'Object', className: 'City', objectId: w.cityId },
    });
    const search = await staff('getUsers', {
      limit: 10,
      skip: 0,
      search: { key: 'username', value: w.customer.username },
    });
    expect((search.body.result as { count: number }).count).toBe(1);
    const byCity = await staff('getUsers', {
      limit: 0,
      skip: 0,
      cityId: w.cityId,
      appType: 'food',
    });
    expect(byCity.body.result).toMatchObject({ count: 1, results: [] });
  });

  it('addUser: new-user defaults, language en, city pointer, Staff role when staffType', async () => {
    const res = await staff('addUser', {
      fullname: 'New Op',
      username: 'newop',
      password: 'secret1',
      email: 'newop@example.test',
      appType: ['staff'],
      cityId: w.cityId,
      enabled: true,
      staffType: 'Staff',
      phone: '0555',
    });
    expect(res.body).toEqual({ result: 1 });
    const [user] = await api.find('_User', { username: 'newop' });
    expect(user).toMatchObject({
      fullname: 'New Op',
      email: 'newop@example.test',
      language: 'en',
      appType: ['staff'],
      enabled: true,
      pushToken: {},
      theme: 'light',
      phone: '0555',
      city: ptr('City', w.cityId),
      promoNotifs: true,
      payment: { method: 'cash', stripeCustomerId: null, stripeDefaultSourceId: null, list: [] },
      cartOptions: {},
      cartFood: [],
      favorites: [],
      promosUsed: [],
      driverActive: false,
      driverRating: 0,
      driverOrdersAccepted: 0,
      driverParams: { ratingTotal: 0, reviews: 0 },
      staffType: 'Staff',
    });
    // Verification email (verifyUserEmails: true).
    await eventually(() =>
      server.ports.effects.some(
        (e) => e.port === 'mail' && (e.args[0] as { to: string }).to === 'newop@example.test',
      ),
    );
    await eventually(async () => {
      const members = await api.find('_User', {
        $relatedTo: { object: ptr('_Role', w.staffRoleId), key: 'users' },
      });
      return members.some((m) => m.objectId === user!.objectId);
    });
    const login = await api.fn('loginStaff', { username: 'newop', password: 'secret1' });
    expect(login.body.result).toMatchObject({ sessionToken: expect.any(String) });
  });

  // The inventory said an omitted staffType clears it. It doesn't: legacy's SDK drops keys set to
  // undefined, so the field is left alone (v2 keeps that via wire-json.ts).
  it('editUser: omitted staffType is left alone; email only when changed; password when given', async () => {
    const u = await makeUser(api, { appType: ['driver'], staffType: 'Staff' });
    const res = await staff('editUser', {
      id: u.id,
      fullname: 'Renamed',
      email: `${u.username}@example.test`,
      phone: '0666',
      appType: ['driver'],
      cityId: w.cityId,
      password: 'newpass',
    });
    expect(res.body).toEqual({ result: 1 });
    const after = (await api.get('_User', u.id))!;
    expect(after).toMatchObject({
      fullname: 'Renamed',
      phone: '0666',
      city: ptr('City', w.cityId),
    });
    expect(after.staffType).toBe('Staff');
    const login = await api.request('POST', '/login', {
      username: u.username,
      password: 'newpass',
    });
    expect(login.status).toBe(200);
  });

  it('toggleEnableUsers: disabling a manager disables the store and its Food, not its Lists', async () => {
    const m = await makeUser(api, { appType: ['manager'], driverActive: true });
    const storeId = await api.create('Restaurant', {
      name: 'Toggle',
      enabled: true,
      manager: ptr('_User', m.id),
    });
    await api.update('_User', m.id, { managerStore: ptr('Restaurant', storeId) });
    const listId = await api.create('List', {
      name: 'L',
      restaurant: ptr('Restaurant', storeId),
      enabled: true,
    });
    const foodId = await api.create('Food', {
      name: 'F',
      restaurant: ptr('Restaurant', storeId),
      list: ptr('List', listId),
      enabled: true,
    });
    expect((await staff('toggleEnableUsers', { ids: [m.id] })).body).toEqual({ result: 1 });
    expect(await api.get('_User', m.id)).toMatchObject({ enabled: false, driverActive: false });
    expect((await api.get('Restaurant', storeId))!.enabled).toBe(false);
    expect((await api.get('Food', foodId))!.enabled).toBe(false);
    expect((await api.get('List', listId))!.enabled).toBe(true);
    // A disabled user can't log in (beforeLogin), apps see any 141 as "inactive".
    const login = await api.request('POST', '/login', {
      username: m.username,
      password: m.password,
    });
    expect(login.body).toEqual({ code: 141, error: 'ACCOUNT_INACTIVE' });
  });

  it('deleteUsers: manager → sessions, store, lists (→ food via afterDelete List), promos, reviews', async () => {
    const m = await makeUser(api, { appType: ['manager', 'food'] });
    const storeId = await api.create('Restaurant', {
      name: 'Doomed',
      enabled: true,
      manager: ptr('_User', m.id),
    });
    await api.update('_User', m.id, { managerStore: ptr('Restaurant', storeId) });
    const store = ptr('Restaurant', storeId);
    const listId = await api.create('List', { name: 'L', restaurant: store });
    const foodId = await api.create('Food', {
      name: 'F',
      restaurant: store,
      list: ptr('List', listId),
    });
    const promoId = await api.create('Promo', { code: 'DOOM', restaurant: store });
    const reviewId = await api.create('Review', { rating: 4, restaurant: store });
    const addressId = await api.create('Address', { user: ptr('_User', m.id) });
    expect((await staff('deleteUsers', { ids: [m.id] })).body).toEqual({ result: 1 });
    for (const [cls, id] of [
      ['_User', m.id],
      ['Restaurant', storeId],
      ['List', listId],
      ['Food', foodId],
      ['Promo', promoId],
      ['Review', reviewId],
      ['Address', addressId],
    ] as const) {
      expect(await api.get(cls, id), `${cls} ${id}`).toBeUndefined();
    }
    expect(await api.find('_Session', { user: ptr('_User', m.id) })).toEqual([]);
  });
});

describe('stores', () => {
  it('assignManager: store/list/food/promo ACLs, FileObject owners, appType, and unlinks the old manager', async () => {
    const oldM = await makeUser(api, { appType: ['food', 'manager'] });
    const newM = await makeUser(api, { appType: ['food'] });
    const storeId = await api.create('Restaurant', {
      name: 'Move',
      manager: ptr('_User', oldM.id),
      picture: file('store.jpg'),
    });
    await api.update('_User', oldM.id, { managerStore: ptr('Restaurant', storeId) });
    const store = ptr('Restaurant', storeId);
    const listId = await api.create('List', { name: 'L', restaurant: store });
    const foodId = await api.create('Food', {
      name: 'F',
      restaurant: store,
      picture: file('food.jpg'),
    });
    const promoId = await api.create('Promo', { code: 'MOVE', restaurant: store });
    const storeFile = await api.create('FileObject', {
      fileName: 'store.jpg',
      createdBy: ptr('_User', oldM.id),
    });
    const foodFile = await api.create('FileObject', {
      fileName: 'food.jpg',
      createdBy: ptr('_User', oldM.id),
    });

    expect((await staff('assignManager', { storeId, managerId: newM.id })).body).toEqual({
      result: 1,
    });
    const managerAcl = { '*': { read: true }, [newM.id]: { write: true } };
    expect(await api.get('Restaurant', storeId)).toMatchObject({
      manager: ptr('_User', newM.id),
      ACL: { ...managerAcl, 'role:Staff': { write: true } },
    });
    expect((await api.get('List', listId))!.ACL).toEqual(managerAcl);
    expect((await api.get('Food', foodId))!.ACL).toEqual(managerAcl);
    expect((await api.get('Promo', promoId))!.ACL).toEqual(managerAcl);
    expect((await api.get('FileObject', storeFile))!.createdBy).toEqual(ptr('_User', newM.id));
    expect((await api.get('FileObject', foodFile))!.createdBy).toEqual(ptr('_User', newM.id));
    expect(await api.get('_User', newM.id)).toMatchObject({
      appType: ['food', 'manager'],
      managerStore: ptr('Restaurant', storeId),
    });
    const old = (await api.get('_User', oldM.id))!;
    expect(old.appType).toEqual(['food']);
    expect(old.managerStore).toBeUndefined();

    // No managerId: unassign.
    await staff('assignManager', { storeId });
    expect((await api.get('Restaurant', storeId))!.manager).toBeUndefined();
  });

  it('toggleEnableStores flips store, manager, lists and food; changeRegion moves store + food', async () => {
    const m = await makeUser(api, { appType: ['manager'] });
    const storeId = await api.create('Restaurant', {
      name: 'T',
      enabled: true,
      manager: ptr('_User', m.id),
    });
    const store = ptr('Restaurant', storeId);
    const listId = await api.create('List', { name: 'L', restaurant: store, enabled: true });
    const foodId = await api.create('Food', { name: 'F', restaurant: store, enabled: true });
    await staff('toggleEnableStores', { ids: [storeId] });
    for (const [cls, id] of [
      ['Restaurant', storeId],
      ['_User', m.id],
      ['List', listId],
      ['Food', foodId],
    ] as const) {
      expect((await api.get(cls, id))!.enabled, cls).toBe(false);
    }
    const cityId = await api.create('City', { name: 'Oran' });
    await staff('changeRegion', { storeId, cityId });
    expect((await api.get('Restaurant', storeId))!.city).toEqual(ptr('City', cityId));
    expect((await api.get('Food', foodId))!.city).toEqual(ptr('City', cityId));
  });

  it('deleteStores: store, manager (+sessions), lists → food, promos, reviews', async () => {
    const m = await makeUser(api, { appType: ['manager'] });
    const storeId = await api.create('Restaurant', { name: 'Gone', manager: ptr('_User', m.id) });
    const store = ptr('Restaurant', storeId);
    const listId = await api.create('List', { name: 'L', restaurant: store });
    const foodId = await api.create('Food', {
      name: 'F',
      restaurant: store,
      list: ptr('List', listId),
    });
    const promoId = await api.create('Promo', { code: 'GONE', restaurant: store });
    expect((await staff('deleteStores', { ids: [storeId] })).body).toEqual({ result: 1 });
    for (const [cls, id] of [
      ['Restaurant', storeId],
      ['_User', m.id],
      ['List', listId],
      ['Food', foodId],
      ['Promo', promoId],
    ] as const) {
      expect(await api.get(cls, id), cls).toBeUndefined();
    }
  });
});

describe('catalogue', () => {
  it('editList / editProduct set every param but id (Q-2); afterSave Food maintains store isDiscount', async () => {
    expect((await staff('editList', { id: w.listId, name: 'Renamed', position: 3 })).body).toEqual({
      result: 1,
    });
    expect(await api.get('List', w.listId)).toMatchObject({ name: 'Renamed', position: 3 });
    // Q-1: only `id` is required.
    expect((await staff('editList', {})).body.error).toBe('PARAMS_MISSING');
    expect(
      (await staff('editProduct', { id: w.foodId, isDiscount: true, price: 700 })).body,
    ).toEqual({ result: 1 });
    expect((await api.get('Restaurant', w.storeId))!.isDiscount).toBe(true);
    await staff('editProduct', { id: w.foodId, isDiscount: false });
    expect((await api.get('Restaurant', w.storeId))!.isDiscount).toBe(false);
  });

  it('duplicateProduct copies fields and ACL, not objectId/picture', async () => {
    const id = await api.create('Food', {
      name: 'Dup',
      restaurant: ptr('Restaurant', w.storeId),
      price: 5,
      picture: file('dup.jpg'),
      ACL: { '*': { read: true } },
    });
    expect((await staff('duplicateProduct', { id })).body).toEqual({ result: 1 });
    const copies = await api.find('Food', { name: 'Dup' });
    expect(copies).toHaveLength(2);
    const copy = copies.find((c) => c.objectId !== id)!;
    expect(copy).toMatchObject({
      restaurant: ptr('Restaurant', w.storeId),
      price: 5,
      ACL: { '*': { read: true } },
    });
    expect(copy.picture).toBeUndefined();
    expect(copy.createdAt).not.toBe(copies.find((c) => c.objectId === id)!.createdAt);
  });

  it('assignList / assignProduct / assignPromo grant the store manager write access', async () => {
    const promoId = await api.create('Promo', { code: 'ASSIGN' });
    const expected = { '*': { read: true }, [w.manager.id]: { write: true } };
    await staff('assignList', { id: w.listId, restaurantId: w.storeId });
    await staff('assignProduct', { id: w.foodId, restaurantId: w.storeId });
    await staff('assignPromo', { id: promoId, restaurantId: w.storeId });
    expect((await api.get('List', w.listId))!.ACL).toEqual(expected);
    expect((await api.get('Food', w.foodId))!.ACL).toEqual(expected);
    expect((await api.get('Promo', promoId))!.ACL).toEqual(expected);
  });

  it('promos: uniquePromo, editPromo pointers/dates, isPromo triggers', async () => {
    const promoId = await api.create('Promo', {
      code: 'SUMMER',
      restaurant: ptr('Restaurant', w.storeId),
      expirationDate: { __type: 'Date', iso: '2000-01-01T00:00:00.000Z' },
    });
    expect((await api.get('Restaurant', w.storeId))!.isPromo).toBe(true); // afterSave Promo
    expect((await api.fn('uniquePromo', { code: 'SUMMER' }, w.manager.session)).body.error).toBe(
      'PROMO_EXISTS',
    );
    expect((await api.fn('uniquePromo', { code: 'WINTER' }, w.manager.session)).body).toEqual({
      result: 1,
    });
    expect((await api.fn('uniquePromo', {}, w.manager.session)).body.error).toBe('MISSING_PARAMS');

    await staff('editPromo', {
      id: promoId,
      code: 'IGNORED',
      cityId: w.cityId,
      foodId: w.foodId,
      expirationDate: '2030-06-01T00:00:00.000Z',
      value: 10,
    });
    const promo = (await api.get('Promo', promoId))!;
    expect(promo).toMatchObject({
      code: 'SUMMER',
      city: ptr('City', w.cityId),
      food: ptr('Food', w.foodId),
      value: 10,
      expirationDate: { __type: 'Date', iso: '2030-06-01T00:00:00.000Z' },
    });
    expect(promo.restaurant).toBeUndefined(); // editPromo clears pointers it isn't given

    // afterDelete Promo: isPromo goes false when no unexpired promo is left for the store.
    const expired = await api.create('Promo', {
      code: 'OLD',
      restaurant: ptr('Restaurant', w.storeId),
      expirationDate: { __type: 'Date', iso: '2000-01-01T00:00:00.000Z' },
    });
    await staff('deletePromos', { ids: [expired] });
    expect((await api.get('Restaurant', w.storeId))!.isPromo).toBe(false);
  });

  it('deletelists (lower-case l) cascades to Food via afterDelete List', async () => {
    const listId = await api.create('List', {
      name: 'Tmp',
      restaurant: ptr('Restaurant', w.storeId),
    });
    const foodId = await api.create('Food', {
      name: 'TmpFood',
      restaurant: ptr('Restaurant', w.storeId),
      list: ptr('List', listId),
    });
    expect((await staff('deletelists', { ids: [listId] })).body).toEqual({ result: 1 });
    expect(await api.get('Food', foodId)).toBeUndefined();
    expect((await staff('deleteLists', { ids: [] })).body.error).toBe(
      'Invalid function: "deleteLists"',
    );
  });
});

describe('reviews and messages (triggers)', () => {
  it('afterSave Review copies the reviewer city and updates store / driver ratings', async () => {
    const reviewer = await makeUser(api, { appType: ['food'], city: w.city });
    const saved = await api.request<{ objectId: string }>(
      'POST',
      '/classes/Review',
      { rating: 4, restaurant: ptr('Restaurant', w.storeId) },
      { session: reviewer.session },
    );
    expect(saved.status).toBe(201);
    expect((await api.get('Review', saved.body.objectId))!.city).toEqual(w.city);
    expect(await api.get('Restaurant', w.storeId)).toMatchObject({
      ratingTotal: 4,
      reviews: 1,
      rating: 4,
    });
    await api.request(
      'POST',
      '/classes/Review',
      { rating: 3, restaurant: ptr('Restaurant', w.storeId) },
      { session: reviewer.session },
    );
    expect(await api.get('Restaurant', w.storeId)).toMatchObject({
      ratingTotal: 7,
      reviews: 2,
      rating: 3.5,
    });

    const driver = await makeDriver(api, 90, { driverActive: false });
    await api.request(
      'POST',
      '/classes/Review',
      { rating: 5, driver: ptr('_User', driver.id) },
      { session: reviewer.session },
    );
    await api.request(
      'POST',
      '/classes/Review',
      { rating: 2, driver: ptr('_User', driver.id) },
      { session: reviewer.session },
    );
    expect(await api.get('_User', driver.id)).toMatchObject({
      driverParams: { ratingTotal: 7, reviews: 2 },
      driverRating: 3.5,
    });

    // Q-8: a master-key save has no user, so the trigger does nothing.
    await api.create('Review', { rating: 1, restaurant: ptr('Restaurant', w.storeId) });
    expect((await api.get('Restaurant', w.storeId))!.reviews).toBe(2);
  });

  it('afterSave Message pushes staff in the sender city with page "support"', async () => {
    const sender = await makeUser(api, { appType: ['driver'], city: w.city, fullname: 'Karim' });
    // In prod the class exists (created in Parse Dashboard); clients can't create classes.
    await api.create('Message', { fullname: 'seed' });
    server.ports.reset();
    const saved = await api.request<{ objectId: string }>(
      'POST',
      '/classes/Message',
      { fullname: 'Karim', text: 'hello' },
      { session: sender.session },
    );
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toEqual({
      android: { priority: 'high' },
      notification: { title: `New message #${saved.body.objectId} from: Karim` },
      data: { notifId: expect.stringMatching(/^\d{8}$/), id: saved.body.objectId, page: 'support' },
      token: 'tok-staff',
    });
    expect((await staff('deleteMessages', { ids: [saved.body.objectId] })).body).toEqual({
      result: 1,
    });
    expect(await api.get('Message', saved.body.objectId)).toBeUndefined();
  });
});

describe('orders and push (staff)', () => {
  it('assignDriver: DRIVER_DISCONNECTED unless enabled + active; clears driver; FCM or Pusher by Config', async () => {
    const orderId = await placeOrder(api, w);
    const idle = await makeDriver(api, 30, { driverActive: false });
    expect((await staff('assignDriver', { orderId, driverId: idle.id })).body.error).toBe(
      'DRIVER_DISCONNECTED',
    );
    expect((await staff('assignDriver', { orderId, driverId: 'ghost' })).body.error).toBe(
      'DRIVER_DISCONNECTED',
    );
    const driver = await makeDriver(api, 31);
    await api.update('Order', orderId, { canceled: true, driver: ptr('_User', idle.id) });
    server.ports.reset();
    expect((await staff('assignDriver', { orderId, driverId: driver.id })).body).toEqual({
      result: 1,
    });
    const order = (await api.get('Order', orderId))!;
    expect(order.canceled).toBe(false);
    expect(order.driver).toBeUndefined();
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toMatchObject({
      token: 'tok-driver-31',
      data: { id: orderId, newOrder: 'true' },
    });

    await api.request('PUT', '/config', { params: { driverRealtime: true } }, { master: true });
    server.ports.reset();
    await staff('assignDriver', { orderId, driverId: driver.id });
    await eventually(() => server.ports.effects.some((e) => e.port === 'realtime'));
    expect(server.ports.effects.find((e) => e.port === 'realtime')?.args).toEqual([
      driver.id,
      'orderEvent',
      { data: { id: orderId } },
    ]);
    // D-19: FCM goes out alongside Pusher, for a driver whose socket is gone.
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toMatchObject({
      token: 'tok-driver-31',
      data: { id: orderId, newOrder: 'true', launchApp: 'true', playSound: 'true' },
    });
    await api.request('PUT', '/config', { params: { driverRealtime: false } }, { master: true });
    await api.update('_User', driver.id, { driverActive: false });
  });

  it('editOrder merges options, maps foodIds; deleteOrders destroys', async () => {
    const orderId = await placeOrder(api, w);
    await staff('editOrder', {
      id: orderId,
      status: 2,
      canceled: false,
      options: { extra: 1 },
      foodIds: [w.foodId, w.foodId],
    });
    expect(await api.get('Order', orderId)).toMatchObject({
      status: 2,
      canceled: false,
      options: { note: 'no onions', extra: 1 },
      food: [ptr('Food', w.foodId), ptr('Food', w.foodId)],
    });
    expect((await staff('editOrder', { id: 'missing' })).body).toEqual({ result: 1 });
    expect((await staff('deleteOrders', { ids: [orderId] })).body).toEqual({ result: 1 });
    expect(await api.get('Order', orderId)).toBeUndefined();
  });

  it('sendPush: to a user slot, a city condition, or a topic; data forwarded untouched', async () => {
    expect(
      (await staff('sendPush', { title: 'Hi', userId: 'ghost', appType: 'food' })).body.error,
    ).toBe('USER_DOES_NOT_EXISTS');
    expect(
      (await staff('sendPush', { title: 'Hi', userId: w.customer.id, appType: 'driver' })).body
        .error,
    ).toBe('USER_PUSH_TOKEN_MISSING');
    expect((await staff('sendPush', { title: 'Hi' })).body.error).toBe(
      'SEND_PUSH_NOTIFICATION_PARAMS_MISSING',
    );
    await staff('sendPush', {
      title: 'Hi',
      body: 'There',
      imageUrl: 'https://x/y.png',
      data: { screen: 'Home' },
      userId: w.customer.id,
      appType: 'food',
    });
    await staff('sendPush', { title: 'City', cityId: w.cityId, appType: 'food' });
    await staff('sendPush', { title: 'All', appType: 'driver' });
    await eventually(() => server.ports.pushes().length === 3);
    expect(server.ports.pushes()).toEqual([
      {
        android: { priority: 'high' },
        notification: { title: 'Hi', body: 'There', imageUrl: 'https://x/y.png' },
        data: { screen: 'Home' },
        token: 'tok-customer',
      },
      {
        android: { priority: 'high' },
        notification: { title: 'City' },
        condition: `'food' in topics && '${w.cityId}' in topics`,
      },
      { android: { priority: 'high' }, notification: { title: 'All' }, topic: 'driver' },
    ]);
  });
});

describe('updateConfigs', () => {
  // Q-9 in the inventory was wrong: 4.3 and 9.x only write masterKeyOnly.<key> for the keys in
  // params, so the SDK's `{ useMasterKey: true }` flags argument never reaches the DB.
  it('saves the params; masterKeyOnly is false for each saved key', async () => {
    expect((await staff('updateConfigs', {})).body.error).toBe('PARAMS_MISSING');
    expect((await staff('updateConfigs', { configs: { pickupEnabled: false } })).body).toEqual({
      result: 1,
    });
    const config = await server.switchApp.mongo.db().collection('_GlobalConfig').findOne({});
    expect(config).toMatchObject({
      params: { pickupEnabled: false },
      masterKeyOnly: { pickupEnabled: false },
    });
    expect(config?.masterKeyOnly).not.toHaveProperty('useMasterKey');
  });
});
