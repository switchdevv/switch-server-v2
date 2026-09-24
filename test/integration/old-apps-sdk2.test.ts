// Old app builds (plan §7 "SDK matrix", RK-7). Every food, driver and manager build released
// before the RN 0.81 upgrade (versionName 1.0, and the dashboard) talks to the server through the
// Parse JS SDK 2.17.0, which puts the app id, session token and method override in a text/plain
// POST body instead of headers. These calls follow the apps' own src/api layer (auth, objects,
// files, cloud, config) at their last 2.17 commit, through the real SDK 2.17.0.
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Client } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeWorld, RESTAURANT_LOCATION, type World } from '../helpers/world.js';

// 2.17 ships no types; its API is a subset of 8.6's for everything used here.
const Parse = createRequire(import.meta.url)(
  'parse-sdk-2/node',
) as (typeof import('parse/node'))['default'];

let server: TestServer;
let api: Client;
let w: World;

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  const config = await api.request(
    'PUT',
    '/config',
    { params: { tripDuration: { preparationTime: 10, timePerKm: 3 }, sendManagerNotifs: false } },
    { master: true },
  );
  expect(config.status).toBe(200);
  // What the apps' initAPI does (React Native keeps a current user; Node needs this switch).
  Parse.initialize(server.appId);
  Parse.serverURL = server.url;
  Parse.User.enableUnsafeCurrentUser();
});
afterAll(() => server?.close());

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: { code: number; message: string }) => ({ code: error.code, message: error.message }),
  );
}

describe('SDK 2.17 request shape', () => {
  it('answers a text/plain POST carrying _ApplicationId and _method, as 2.17 sends every call', async () => {
    const res = await fetch(`${server.url}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        _method: 'GET',
        _ApplicationId: server.appId,
        _ClientVersion: 'js2.17.0',
        _InstallationId: 'b3c1a1de-0000-4000-8000-000000000000',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('params');
  });
});

describe('auth module (signup, login, become, putUser, logout, reset)', () => {
  const username = 'old.app.user';
  const password = 'secret12';
  let sessionToken = '';

  it('signs up with the apps’ field set, undefined fields included', async () => {
    const user = new Parse.User();
    user.set('username', username);
    user.set('fullname', 'Old App');
    user.set('password', password);
    user.set('email', 'old.app@example.test');
    user.set('language', 'fr');
    user.set('appType', ['food']);
    user.set('enabled', true);
    user.set('pushToken', {});
    user.set('theme', 'light');
    user.set('phone', undefined);
    user.set('picture', undefined);
    user.set('address', undefined);
    user.set('city', undefined);
    user.set('promoNotifs', true);
    user.set('payment', {
      method: 'cash',
      stripeCustomerId: null,
      stripeDefaultSourceId: null,
      list: [],
    });
    user.set('cartOptions', {});
    user.set('cartFood', []);
    user.set('favorites', []);
    user.set('promosUsed', []);
    user.set('managerStore', undefined);
    user.set('driverActive', false);
    user.set('driverRating', 0);
    user.set('driverLocation', undefined);
    user.set('driverOrdersAccepted', 0);
    user.set('driverParams', { ratingTotal: 0, reviews: 0 });
    user.set('staffType', undefined);
    user.set('tmpUser', true);
    const saved = await user.signUp();
    const json = saved.toJSON();
    expect(json.sessionToken).toMatch(/^r:[A-Za-z0-9]+$/);
    expect(json).toMatchObject({ username, fullname: 'Old App', appType: ['food'], tmpUser: true });
  });

  it('putUser: currentAsync, set, save', async () => {
    const user = await Parse.User.currentAsync();
    user!.set('theme', 'dark');
    user!.set('cartFood', [{ id: w.foodId, quantity: 2 }]);
    const saved = await user!.save();
    expect(saved.toJSON()).toMatchObject({
      theme: 'dark',
      cartFood: [{ id: w.foodId, quantity: 2 }],
    });
    expect(await api.get('_User', saved.id!)).toMatchObject({ theme: 'dark' });
  });

  it('logs out, then logs in with username and password', async () => {
    await Parse.User.logOut();
    expect(await Parse.User.currentAsync()).toBeNull();
    const user = await Parse.User.logIn(username, password);
    expect(user.toJSON()).toMatchObject({ username, email: 'old.app@example.test' });
    expect(user.getSessionToken()).toMatch(/^r:/);
    sessionToken = user.getSessionToken()!;
  });

  it('a wrong password is 101, as the apps expect', async () => {
    expect(await rejection(Parse.User.logIn(username, 'wrong'))).toMatchObject({ code: 101 });
  });

  it('become() with a stored session token (the apps’ boot and social-login path)', async () => {
    const user = await Parse.User.become(sessionToken);
    expect(user.get('username')).toBe(username);
    expect(await rejection(Parse.User.become('r:doesnotexist'))).toMatchObject({ code: 209 });
    await Parse.User.become(sessionToken);
  });

  it('loginWithGoogle then become(sessionToken)', async () => {
    const result = (await Parse.Cloud.run('loginWithGoogle', {
      idToken: 'valid:g-old',
      clientUser: { id: 'g-old', email: 'google.old@example.test', name: 'G Old' },
      language: 'fr',
      appType: ['food'],
    })) as { newUser: boolean; sessionToken: string; invalidUser?: boolean };
    expect(result.invalidUser).toBeFalsy();
    const user = await Parse.User.become(result.sessionToken);
    expect(user.get('email')).toBe('google.old@example.test');
    await Parse.User.logIn(username, password);
  });

  it('requestPasswordReset', async () => {
    await expect(Parse.User.requestPasswordReset('old.app@example.test')).resolves.toBeDefined();
  });

  it('Config.get', async () => {
    const config = await Parse.Config.get();
    expect(config).toBeInstanceOf(Parse.Config);
  });
});

describe('objects module (queries, create with ACL, update, delete)', () => {
  it('find with equalTo, include, descending, limit', async () => {
    const rows = await new Parse.Query('Food')
      .equalTo('restaurant', Parse.Object.extend('Restaurant').createWithoutData(w.storeId))
      .include('restaurant')
      .descending('createdAt')
      .limit(10)
      .find();
    expect(rows.map((r) => r.toJSON())).toMatchObject([
      { name: 'Margherita', restaurant: { objectId: w.storeId, name: 'Chez Test' } },
    ]);
  });

  it('withinKilometers (sorted), near, count, first, fullText', async () => {
    const here = new Parse.GeoPoint(RESTAURANT_LOCATION);
    const within = await new Parse.Query('Restaurant')
      .withinKilometers('location', here, 5, true)
      .find();
    expect(within.map((r) => r.id)).toEqual([w.storeId]);
    const near = await new Parse.Query('Restaurant').near('location', here).first();
    expect(near?.id).toBe(w.storeId);
    expect(await new Parse.Query('Restaurant').equalTo('enabled', true).count()).toBe(1);
    const text = await new Parse.Query('Food').fullText('name', 'Margherita').find();
    expect(text.map((r) => r.id)).toEqual([w.foodId]);
  });

  it('post: a new Address with the user’s ACL, then put and del', async () => {
    const user = await Parse.User.currentAsync();
    const address = new Parse.Object('Address');
    address.set('user', user);
    address.set('name', 'Work');
    address.set('location', new Parse.GeoPoint({ latitude: 36.7, longitude: 3.1 }));
    address.setACL(new Parse.ACL(user));
    const created = await address.save();
    expect(created.id).toBeTruthy();

    const found = await new Parse.Query('Address').equalTo('objectId', created.id).first();
    found!.set('name', 'Office');
    expect((await found!.save()).get('name')).toBe('Office');

    await found!.destroy();
    expect(await api.get('Address', created.id!)).toBeUndefined();
  });

  it('another user can’t read an object behind that ACL', async () => {
    const address = new Parse.Object('Address');
    address.set('name', 'Private');
    address.setACL(new Parse.ACL(await Parse.User.currentAsync()));
    const created = await address.save();
    const res = await api.request('GET', `/classes/Address/${created.id}`, undefined, {
      session: w.customer.session,
    });
    expect(res.body.code).toBe(101);
  });
});

describe('files module', () => {
  it('uploads a base64 file while signed in, then deleteFile', async () => {
    const file = new Parse.File('profile.jpeg', {
      base64: Buffer.from('jpeg-bytes').toString('base64'),
    });
    await file.save();
    expect(file.name()).toMatch(/_profile\.jpeg$/);
    expect(file.url()).toMatch(/profile\.jpeg$/);
    await expect(Parse.Cloud.run('deleteFile', { filename: file.name() })).resolves.toBe(1);
  });
});

describe('cloud module', () => {
  it('a legacy error string reaches the app as code 141 with the same message', async () => {
    await Parse.User.logOut();
    expect(await rejection(Parse.Cloud.run('calculateOrder', {}))).toEqual({
      code: 141,
      message: 'USER_UNAUTHENTICATED',
    });
  });

  it('calculateOrder and placeOrder as the food app sends them', async () => {
    await Parse.User.become(w.customer.session);
    server.ports.script.distanceResponse = () => ({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', distance: { text: '3.2 km' } }] }],
    });
    const priced = (await Parse.Cloud.run('calculateOrder', {
      from: RESTAURANT_LOCATION,
      to: { latitude: 36.77, longitude: 3.05 },
      city: { fees: { food: { initial: 150, minKms: 3, perExtraKm: 30 } } },
      appType: 'food',
    })) as { delivery: number };
    expect(priced.delivery).toBeGreaterThan(0);

    const placed = await Parse.Cloud.run('placeOrder', {
      userId: w.customer.id,
      restaurantId: w.storeId,
      userAddressId: w.addressId,
      foodIds: [w.foodId],
      deliveryType: 'delivery',
      type: 'food',
      options: {},
      distance: 3.2,
      duration: 20,
    });
    expect(placed).toBe(1);
    const orders = await new Parse.Query('Order').find();
    expect(orders).toHaveLength(1);
  });
});
