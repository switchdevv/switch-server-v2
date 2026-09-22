// Auth: social logins, verifyPhone, beforeLogin/afterLogout, savePayment (inventory §3.1 #1–#4, #9, §3.3).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeUser } from '../helpers/world.js';

let server: TestServer;
let api: Client;

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

const rawUser = (id: string) =>
  server.switchApp.mongo
    .db()
    .collection('_User')
    .findOne({ _id: id as never });

describe('loginWithGoogle', () => {
  const google = (clientUser: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    api.fn('loginWithGoogle', {
      idToken: `valid:${String(clientUser.id)}`,
      clientUser,
      language: 'fr',
      appType: ['food'],
      ...extra,
    });

  it('param checks: LOGIN_WITH_GOOGLE_PARAMS_MISSING, then EMAIL_MISSING', async () => {
    expect((await api.fn('loginWithGoogle', { idToken: 'x' })).body).toEqual({
      code: 141,
      error: 'LOGIN_WITH_GOOGLE_PARAMS_MISSING',
    });
    expect((await google({ id: 'g1' })).body).toEqual({ code: 141, error: 'EMAIL_MISSING' });
  });

  it('noNewUser: { invalidUser: true } and nothing is created', async () => {
    const res = await google({ id: 'g0', email: 'nobody@example.test' }, { noNewUser: true });
    expect(res.body).toEqual({ result: { invalidUser: true } });
    expect(await api.find('_User', { email: 'nobody@example.test' })).toEqual([]);
  });

  it('new user: signs up with the new-user defaults, links Google, returns a session', async () => {
    const res = await google({
      id: 'g1',
      email: 'amel.b@example.test',
      name: 'Amel B',
      photo: 'https://p/1.jpg',
    });
    expect(res.body.result).toEqual({ newUser: true, sessionToken: expect.stringMatching(/^r:/) });
    const [user] = await api.find('_User', { email: 'amel.b@example.test' });
    // Like legacy over HTTP: signUp and linkWith each open a session under the SDK's installation id,
    // and Parse drops the older one for the same installation (destroyDuplicatedSessions).
    const sessions = await api.find('_Session', {
      user: { __type: 'Pointer', className: '_User', objectId: user!.objectId },
    });
    expect(sessions).toHaveLength(1);
    expect(
      sessions.every((s) => typeof s.installationId === 'string' && s.installationId !== 'cloud'),
    ).toBe(true);
    expect(user).toMatchObject({
      username: 'amel.b',
      fullname: 'Amel B',
      language: 'fr',
      appType: ['food'],
      enabled: true,
      pushToken: {},
      theme: 'light',
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
      authData: { google: { id: 'g1' } },
    });
    // Keys legacy set to `undefined` are absent (not null), as over legacy's HTTP loop.
    const raw = (await rawUser(user!.objectId as string))!;
    for (const key of [
      'phone',
      '_p_picture',
      'picture',
      '_p_address',
      '_p_city',
      '_p_managerStore',
      'driverLocation',
      'staffType',
    ]) {
      expect(raw, key).not.toHaveProperty(key);
    }
    const me = await api.request('GET', '/users/me', undefined, {
      session: (res.body.result as { sessionToken: string }).sessionToken,
    });
    expect(me.body).toMatchObject({ username: 'amel.b' });
  });

  it('existing user: links and logs in; a disabled one is ACCOUNT_INACTIVE; a bad token is refused', async () => {
    const res = await google({ id: 'g1', email: 'amel.b@example.test', name: 'Other' });
    expect(res.body.result).toEqual({ newUser: false, sessionToken: expect.stringMatching(/^r:/) });
    const bad = await api.fn('loginWithGoogle', {
      idToken: 'forged',
      clientUser: { id: 'g1', email: 'amel.b@example.test' },
      language: 'en',
      appType: 'food',
    });
    expect(bad.body.code).toBe(101);
    const [user] = await api.find('_User', { email: 'amel.b@example.test' });
    await api.update('_User', user!.objectId as string, { enabled: false });
    expect((await google({ id: 'g1', email: 'amel.b@example.test' })).body).toEqual({
      code: 141,
      error: 'ACCOUNT_INACTIVE',
    });
  });
});

describe('loginWithApple / loginWithFacebook', () => {
  it('Apple: fullname falls back to the e-mail local part', async () => {
    const res = await api.fn('loginWithApple', {
      identityToken: 'valid:a1',
      clientUser: { id: 'a1', email: 'x.y@privaterelay.test' },
      language: 'ar',
      appType: ['driver'],
    });
    expect(res.body.result).toMatchObject({ newUser: true });
    const [user] = await api.find('_User', { email: 'x.y@privaterelay.test' });
    expect(user).toMatchObject({
      username: 'x.y',
      fullname: 'x.y',
      language: 'ar',
      appType: ['driver'],
      authData: { apple: { id: 'a1' } },
    });
    expect((await api.fn('loginWithApple', { identityToken: 'x' })).body.error).toBe(
      'LOGIN_WITH_APPLE_PARAMS_MISSING',
    );
  });

  it('Facebook: needs picture.data.url; photo comes from it', async () => {
    const base = {
      accessToken: 'valid:f1',
      expirationDate: '2030-01-01',
      language: 'en',
      appType: ['food'],
    };
    const res = await api.fn('loginWithFacebook', {
      ...base,
      clientUser: {
        id: 'f1',
        email: 'fb@example.test',
        name: 'FB',
        picture: { data: { url: 'https://fb/p.jpg' } },
      },
    });
    expect(res.body.result).toMatchObject({ newUser: true });
    expect((await api.fn('loginWithFacebook', { accessToken: 'x' })).body.error).toBe(
      'LOGIN_WITH_FACEBOOK_PARAMS_MISSING',
    );
  });
});

describe('verifyPhone', () => {
  it('sends the OTP + the app hash and returns the code', async () => {
    const res = await api.fn('verifyPhone', { phoneNumber: '+213555000000', appType: 'food' });
    expect(res.body).toEqual({ result: { code: '4321' } });
    expect(server.ports.effects).toEqual([
      {
        port: 'sms',
        call: 'send',
        args: ['+213555000000', 'Your Switch code is: 4321\nhashFood000'],
      },
    ]);
  });

  it('array appType reads the same hash (property access coerces)', async () => {
    await api.fn('verifyPhone', { phoneNumber: '1', appType: ['driver'] });
    expect(server.ports.effects[0]?.args[1]).toBe('Your Switch code is: 4321\nhashDriver00');
  });

  it('VERIFY_PHONE_ERROR unless the provider says success; params checked first', async () => {
    server.ports.script.smsResponse = { status: 'error', message: 'no credit' };
    expect((await api.fn('verifyPhone', { phoneNumber: '1', appType: 'food' })).body.error).toBe(
      'VERIFY_PHONE_ERROR',
    );
    expect((await api.fn('verifyPhone', { phoneNumber: '1' })).body.error).toBe(
      'VERIFY_PHONE_PARAMS_MISSING',
    );
  });
});

describe('login triggers', () => {
  it('beforeLogin: /login of a disabled user is 141 ACCOUNT_INACTIVE (apps treat any 141 as inactive)', async () => {
    const u = await makeUser(api, { appType: ['food'], enabled: false });
    const res = await api.request('POST', '/login', { username: u.username, password: u.password });
    expect(res.body).toEqual({ code: 141, error: 'ACCOUNT_INACTIVE' });
  });

  it('afterLogout: driverActive goes false', async () => {
    const d = await makeUser(api, { appType: ['driver'], driverActive: true });
    const login = await api.request<{ sessionToken: string }>('POST', '/login', {
      username: d.username,
      password: d.password,
    });
    await api.request('POST', '/logout', {}, { session: login.body.sessionToken });
    await eventually(async () => (await api.get('_User', d.id))!.driverActive === false);
  });

  it('a session issued by v2 is a revocable r: token that /users/me accepts (X-1 shape)', async () => {
    const u = await makeUser(api, { appType: ['food'] });
    expect(u.session).toMatch(/^r:[A-Za-z0-9]+$/);
    const me = await api.request('GET', '/users/me', undefined, { session: u.session });
    expect(me.status).toBe(200);
  });
});

describe('savePayment (card payments are off, D-12)', () => {
  it('checks the session and tokenId as legacy, then refuses: no Stripe call, user row untouched', async () => {
    const u = await makeUser(api, { appType: ['food'] });
    expect((await api.fn('savePayment', { tokenId: 'tok' })).body.error).toBe(
      'USER_UNAUTHENTICATED',
    );
    expect((await api.fn('savePayment', {}, u.session)).body.error).toBe(
      'SAVE_PAYMENT_PARAMS_MISSING',
    );
    const res = await api.fn('savePayment', { tokenId: 'tok_visa' }, u.session);
    expect(res.body).toEqual({ code: 141, error: 'FAILED_TO_PROCESS_PAYMENT' });
    // Only the sign-up verification email (sent in the background); nothing leaves for payments.
    expect(server.ports.effects.filter((e) => e.port !== 'mail')).toEqual([]);
    expect((await api.get('_User', u.id))!.payment).toMatchObject({ stripeCustomerId: null });
  });
});
