// Order lifecycle: food → manager → driver functions (inventory §3.1 #5–#20).
// Expectations are read from the legacy source (cloud/order/*.js) and pinned here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeUser, makeWorld, placeOrder, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;

async function setConfig(params: Record<string, unknown>) {
  const res = await api.request('PUT', '/config', { params }, { master: true });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await setConfig({
    tripDuration: { preparationTime: 10, timePerKm: 3 },
    driverRealtime: false,
    noDriverHandleAdmin: false,
    sendNotifsToAll: false,
    sendManagerNotifs: false,
  });
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

describe('calculateOrder', () => {
  const params = (fees: Record<string, unknown>) => ({
    from: { latitude: 36.75, longitude: 3.06 },
    to: { latitude: 36.77, longitude: 3.05 },
    city: { fees: { food: fees } },
    appType: 'food',
  });
  const distanceText = (text: string) => {
    server.ports.script.distanceResponse = () => ({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', distance: { text } }] }],
    });
  };

  it('requires a session, then from/to/city/appType', async () => {
    expect((await api.fn('calculateOrder', params({}))).body).toEqual({
      code: 141,
      error: 'USER_UNAUTHENTICATED',
    });
    expect((await api.fn('calculateOrder', { from: {} }, w.customer.session)).body.error).toBe(
      'MISSING_PARAMS',
    );
  });

  it('calls Distance Matrix with lat,lng strings and prices the one-tier table', async () => {
    distanceText('4.2 km'); // → rounded to 4.5 km
    const res = await api.fn(
      'calculateOrder',
      params({ initial: 150, minKms: 3, perExtraKm: 30 }),
      w.customer.session,
    );
    // duration = ceil(10 + 4.2 * 3) = 23; delivery = 150 + parseInt((4.5 - 3) * 30) = 195
    expect(res.body.result).toEqual({ distance: 4.2, duration: 23, delivery: 195 });
    expect(server.ports.effects).toContainEqual({
      port: 'distance',
      call: 'matrix',
      args: ['36.75,3.06', '36.77,3.05'],
    });
  });

  it('prices the two-tier table (minKmsExtra)', async () => {
    const fees = { initial: 150, minKms: 3, perExtraKm: 30, initialExtra: 250, minKmsExtra: 6 };
    distanceText('5.6 km'); // → 6 km: second tier, flat initialExtra
    expect(
      (await api.fn('calculateOrder', params(fees), w.customer.session)).body.result,
    ).toMatchObject({ delivery: 250 });
    distanceText('7.3 km'); // → 7.5 km: 250 + parseInt(1.5 * 30)
    expect(
      (await api.fn('calculateOrder', params(fees), w.customer.session)).body.result,
    ).toMatchObject({ delivery: 295 });
    distanceText('2 km'); // exact km, under minKms
    expect(
      (await api.fn('calculateOrder', params(fees), w.customer.session)).body.result,
    ).toMatchObject({ delivery: 150 });
  });

  it('Q-6: parses the display text, so "950 m" is read as 950', async () => {
    distanceText('950 m');
    const res = await api.fn(
      'calculateOrder',
      params({ initial: 150, minKms: 3, perExtraKm: 30 }),
      w.customer.session,
    );
    expect(res.body.result).toMatchObject({ distance: 950 });
  });

  it('DISTANCE_ERROR when Google answers anything but OK', async () => {
    server.ports.script.distanceResponse = () => ({
      status: 'OK',
      rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
    });
    expect((await api.fn('calculateOrder', params({}), w.customer.session)).body.error).toBe(
      'DISTANCE_ERROR',
    );
    server.ports.script.distanceResponse = () => ({ status: 'REQUEST_DENIED' });
    expect((await api.fn('calculateOrder', params({}), w.customer.session)).body.error).toBe(
      'DISTANCE_ERROR',
    );
  });
});

describe('placeOrder', () => {
  it('requires the full payload (distance/duration may be 0)', async () => {
    const res = await api.fn('placeOrder', { userId: 'x' }, w.customer.session);
    expect(res.body.error).toBe('MISSING_PARAMS');
  });

  it('creates the order, bumps ordersTotal and pushes the manager', async () => {
    const before = (await api.get('Restaurant', w.storeId))!;
    const orderId = await placeOrder(api, w, { distance: 0, duration: 0, promoId: 'promo123' });
    const order = (await api.get('Order', orderId))!;
    expect(order).toMatchObject({
      user: ptr('_User', w.customer.id),
      restaurant: ptr('Restaurant', w.storeId),
      userAddress: ptr('Address', w.addressId),
      food: [ptr('Food', w.foodId)],
      deliveryType: 'delivery',
      type: 'food',
      options: { note: 'no onions' },
      distance: 0,
      duration: 0,
      status: 0,
      isReady: false,
      canceled: false,
      driverRated: false,
      city: w.city,
      promo: ptr('Promo', 'promo123'),
    });
    expect((await api.get('Restaurant', w.storeId))!.ordersTotal).toBe(
      (before.ordersTotal as number) + 1,
    );
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()).toEqual([
      {
        android: { priority: 'high' },
        notification: { title: `New Order #${orderId}` },
        data: { id: orderId, newOrder: 'true', launchApp: 'true', playSound: 'true' },
        token: 'tok-manager',
      },
    ]);
  });

  it('pushes staff in the customer city when the manager has no token', async () => {
    const lonelyManager = await makeUser(api, { appType: ['manager'] });
    const storeId = await api.create('Restaurant', {
      name: 'No Token',
      enabled: true,
      manager: ptr('_User', lonelyManager.id),
      ordersTotal: 0,
      city: w.city,
    });
    const orderId = await placeOrder(api, { ...w, storeId });
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toEqual({
      android: { priority: 'high' },
      notification: { title: `New Order #${orderId}` },
      data: { notifId: expect.stringMatching(/^\d{8}$/), id: orderId, page: 'orders' },
      token: 'tok-staff',
    });
  });

  it('STORE_DISABLED for a disabled store', async () => {
    const storeId = await api.create('Restaurant', {
      name: 'Closed',
      enabled: false,
      ordersTotal: 0,
    });
    const res = await api.fn(
      'placeOrder',
      {
        userId: w.customer.id,
        restaurantId: storeId,
        userAddressId: w.addressId,
        foodIds: [w.foodId],
        deliveryType: 'delivery',
        type: 'food',
        options: {},
        distance: 1,
        duration: 1,
      },
      w.customer.session,
    );
    expect(res.body).toEqual({ code: 141, error: 'STORE_DISABLED' });
  });

  it('a card payment is always FAILED_TO_PROCESS_PAYMENT, before any write (legacy, blank Stripe key)', async () => {
    const before = (await api.find('Order')).length;
    const res = await api.fn(
      'placeOrder',
      {
        userId: w.customer.id,
        restaurantId: w.storeId,
        userAddressId: w.addressId,
        foodIds: [w.foodId],
        deliveryType: 'delivery',
        type: 'food',
        options: {},
        distance: 1,
        duration: 1,
        cardPayment: {
          stripeSourceId: 'src_1',
          amount: 1000,
          currency: 'dzd',
          description: 'order',
        },
      },
      w.customer.session,
    );
    expect(res.body).toEqual({ code: 141, error: 'FAILED_TO_PROCESS_PAYMENT' });
    expect(await api.find('Order')).toHaveLength(before);
  });
});

describe('delivery order, end to end', () => {
  it('accept → automatic dispatch → driver accepts → on the way → arrived → finish → rated', async () => {
    const driver = await makeDriver(api, 0.5);
    const orderId = await placeOrder(api, w);
    server.ports.reset();

    // Manager accepts (the manager app never sends noChoose).
    const accepted = await api.fn('acceptManager', { objectId: orderId }, w.manager.session);
    expect(accepted.body).toEqual({ result: 1 });
    expect((await api.get('Order', orderId))!.status).toBe(1);
    await eventually(() => server.ports.pushes().length === 2);
    expect(server.ports.pushes()).toEqual(
      expect.arrayContaining([
        {
          android: { priority: 'high' },
          notification: { title: `Order #${orderId} is Confirmed by Chez Test` },
          data: { id: orderId, icon: 'success', button: 'View Order', screen: 'OrderDetails' },
          token: 'tok-customer',
        },
        // Dispatch round 1 found the driver 0.5 km away (Config driverRealtime=false → FCM).
        // Tagged with the order, so a later send replaces the tray entry (D-21).
        {
          android: { priority: 'high', notification: { tag: orderId } },
          apns: { headers: { 'apns-collapse-id': orderId } },
          notification: { title: `New Order #${orderId}` },
          data: { id: orderId, newOrder: 'true', launchApp: 'true', playSound: 'true' },
          token: 'tok-driver-0.5',
        },
      ]),
    );
    // Round 2 is scheduled in 2 minutes.
    const jobs = await server.switchApp.mongo
      .db()
      .collection('agendaJobs')
      .find({ 'data.objectId': orderId })
      .toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'chooseDriver',
      type: 'normal',
      priority: 0,
      data: { objectId: orderId, iteration: 1, calledDriver: null, lastRun: false },
    });

    // Accepting twice is refused.
    expect(
      (await api.fn('acceptManager', { objectId: orderId }, w.manager.session)).body.error,
    ).toBe('ORDER_FULLFILLED');

    // Driver accepts: order.driver set, pending dispatch rows removed.
    expect((await api.fn('acceptDriver', { objectId: orderId }, driver.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('Order', orderId))!.driver).toEqual(ptr('_User', driver.id));
    expect(
      await server.switchApp.mongo
        .db()
        .collection('agendaJobs')
        .countDocuments({ 'data.objectId': orderId }),
    ).toBe(0);
    const other = await makeDriver(api, 1);
    expect((await api.fn('acceptDriver', { objectId: orderId }, other.session)).body.error).toBe(
      'ORDER_FULLFILLED',
    );

    expect((await api.fn('checkDriver', { objectId: orderId }, driver.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('_User', driver.id))!.driverOrdersAccepted).toBe(1);
    expect((await api.fn('checkDriver', { objectId: orderId }, other.session)).body.error).toBe(
      'ORDER_FULLFILLED',
    );

    server.ports.reset();
    expect(
      (await api.fn('toDestinationDriver', { objectId: orderId }, driver.session)).body,
    ).toEqual({ result: 1 });
    expect((await api.get('Order', orderId))!.status).toBe(2);
    expect((await api.fn('arrivedDriver', { objectId: orderId }, driver.session)).body).toEqual({
      result: 1,
    });
    expect((await api.fn('finishDriver', { objectId: orderId }, driver.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('Order', orderId))!.status).toBe(3);
    await eventually(() => server.ports.pushes().length === 3);
    expect(server.ports.pushes()).toEqual([
      {
        android: { priority: 'high' },
        notification: { title: `Order #${orderId} is On The Way` },
        data: {
          id: orderId,
          icon: 'onTheWay',
          button: 'Track Order',
          screen: 'TrackOrder',
          driverId: driver.id,
        },
        token: 'tok-customer',
      },
      {
        android: { priority: 'high' },
        notification: { title: `Order #${orderId} has arrived` },
        data: { id: orderId, icon: 'arrived', button: 'View Order', screen: 'OrderDetails' },
        token: 'tok-customer',
      },
      // Data only: no notification block.
      {
        android: { priority: 'high' },
        data: { rate: 'true', orderId, id: driver.id, restaurantId: w.storeId },
        token: 'tok-customer',
      },
    ]);

    expect((await api.fn('orderRated', { objectId: orderId }, w.customer.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('Order', orderId))!.driverRated).toBe(true);
    await api.update('_User', driver.id, { driverActive: false });
    await api.update('_User', other.id, { driverActive: false });
  });

  it('acceptManager with noChoose (ops, dashboard) does not dispatch', async () => {
    const orderId = await placeOrder(api, w);
    await api.fn('acceptManager', { objectId: orderId, noChoose: true }, w.manager.session);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await server.switchApp.mongo
        .db()
        .collection('agendaJobs')
        .countDocuments({ 'data.objectId': orderId }),
    ).toBe(0);
  });

  it('acceptManager on a canceled or missing order is ORDER_CANCELED', async () => {
    expect(
      (await api.fn('acceptManager', { objectId: 'nope' }, w.manager.session)).body.error,
    ).toBe('ORDER_CANCELED');
    const orderId = await placeOrder(api, w);
    await api.fn('cancelFood', { objectId: orderId }, w.customer.session);
    expect(
      (await api.fn('acceptManager', { objectId: orderId }, w.manager.session)).body.error,
    ).toBe('ORDER_CANCELED');
  });
});

describe('cancellations', () => {
  it('cancelFood before acceptance; refused after (USER_UNAUTHORIZED)', async () => {
    const orderId = await placeOrder(api, w);
    server.ports.reset();
    expect((await api.fn('cancelFood', { objectId: orderId }, w.customer.session)).body).toEqual({
      result: 1,
    });
    expect((await api.get('Order', orderId))!.canceled).toBe(true);
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toEqual({
      android: { priority: 'high' },
      notification: { title: `Order #${orderId} was canceled by the user` },
      data: { id: orderId, cancel: 'true', icon: 'error' },
      token: 'tok-manager',
    });
    const accepted = await placeOrder(api, w);
    await api.fn('acceptManager', { objectId: accepted, noChoose: true }, w.manager.session);
    expect(
      (await api.fn('cancelFood', { objectId: accepted }, w.customer.session)).body.error,
    ).toBe('USER_UNAUTHORIZED');
  });

  it('cancelManager with a reason pushes customer (with body), driver and staff', async () => {
    const driver = await makeDriver(api, 50, { language: 'fr' });
    const orderId = await placeOrder(api, w);
    await api.update('Order', orderId, { driver: ptr('_User', driver.id) });
    server.ports.reset();
    const res = await api.fn(
      'cancelManager',
      { objectId: orderId, reason: 'Fermé' },
      w.manager.session,
    );
    expect(res.body).toEqual({ result: 1 });
    await eventually(() => server.ports.pushes().length === 3);
    const byToken = Object.fromEntries(server.ports.pushes().map((p) => [p.token, p]));
    expect(byToken['tok-customer']).toEqual({
      android: { priority: 'high' },
      notification: { title: `Order #${orderId} was canceled by Chez Test`, body: 'Reason: Fermé' },
      data: { id: orderId, cancel: 'true', icon: 'error' },
      token: 'tok-customer',
    });
    expect(byToken['tok-driver-50']?.notification).toEqual({
      title: `La commande #${orderId} a été annulée par Chez Test`,
      body: 'Raison: Fermé',
    });
    expect(byToken['tok-staff']?.data).toMatchObject({ id: orderId, page: 'orders' });
    await api.update('_User', driver.id, { driverActive: false });
  });

  it('cancelManager: noNotifs silences customer/driver; fromAdmin silences staff; status > 1 refused', async () => {
    const orderId = await placeOrder(api, w);
    server.ports.reset();
    await api.fn(
      'cancelManager',
      { objectId: orderId, reason: 'x', noNotifs: true, fromAdmin: true },
      w.manager.session,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(server.ports.pushes()).toEqual([]);
    const done = await placeOrder(api, w);
    await api.update('Order', done, { status: 2 });
    expect((await api.fn('cancelManager', { objectId: done }, w.manager.session)).body.error).toBe(
      'ORDER_FULLFILLED',
    );
  });

  it('cancelDriver returns no result; without a reason dispatch restarts skipping that driver', async () => {
    const quitter = await makeDriver(api, 0.3);
    const orderId = await placeOrder(api, w);
    await api.update('Order', orderId, { driver: ptr('_User', quitter.id), status: 1 });
    server.ports.reset();
    const res = await api.fn('cancelDriver', { objectId: orderId }, quitter.session);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect((await api.get('Order', orderId))!.driver).toBeUndefined();
    // The only driver nearby is the one who quit, so the round finds nobody and schedules the
    // extra `lastRun` round.
    const job = await eventually(() =>
      server.switchApp.mongo
        .db()
        .collection('agendaJobs')
        .findOne({ 'data.objectId': orderId, nextRunAt: { $ne: null } }),
    );
    expect(job).toMatchObject({
      data: { objectId: orderId, calledDriver: quitter.id, lastRun: true, iteration: 4 },
    });
    expect(server.ports.pushes().filter((p) => p.token === 'tok-driver-0.3')).toEqual([]);
    await server.switchApp.agendaStore.cancel({ 'data.objectId': orderId });
    await api.update('_User', quitter.id, { driverActive: false });
  });

  it('cancelDriver with a reason notifies staff instead', async () => {
    const driver = await makeDriver(api, 40, { city: w.city });
    const orderId = await placeOrder(api, w);
    await api.update('Order', orderId, { driver: ptr('_User', driver.id), status: 1 });
    server.ports.reset();
    await api.fn('cancelDriver', { objectId: orderId, reason: 'flat tyre' }, driver.session);
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]?.notification?.title).toBe(
      `Order #${orderId} was canceled by the driver - Reason: flat tyre`,
    );
    expect(
      await server.switchApp.mongo
        .db()
        .collection('agendaJobs')
        .countDocuments({ 'data.objectId': orderId }),
    ).toBe(0);
    await api.update('_User', driver.id, { driverActive: false });
  });
});

describe('pickup orders', () => {
  it('finishManager marks ready + status 2 and pushes "prepared"; confirmManager → 3', async () => {
    const orderId = await placeOrder(api, w, { deliveryType: 'pickup' });
    server.ports.reset();
    expect((await api.fn('finishManager', { objectId: orderId }, w.manager.session)).body).toEqual({
      result: 1,
    });
    expect(await api.get('Order', orderId)).toMatchObject({ isReady: true, status: 2 });
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]).toEqual({
      android: { priority: 'high' },
      notification: { title: `Order #${orderId} is Ready for Pickup` },
      data: { id: orderId, icon: 'prepared', button: 'View Order', screen: 'OrderDetails' },
      token: 'tok-customer',
    });
    expect((await api.fn('confirmManager', { objectId: orderId }, w.manager.session)).body).toEqual(
      { result: 1 },
    );
    expect((await api.get('Order', orderId))!.status).toBe(3);
  });

  it('finishManager on a delivery only marks it ready; confirmManager leaves deliveries alone', async () => {
    const orderId = await placeOrder(api, w);
    await api.fn('finishManager', { objectId: orderId }, w.manager.session);
    expect(await api.get('Order', orderId)).toMatchObject({ isReady: true, status: 0 });
    await api.fn('confirmManager', { objectId: orderId }, w.manager.session);
    expect((await api.get('Order', orderId))!.status).toBe(0);
  });
});

describe('Q-11: an unknown language fails after the DB write', () => {
  it('placeOrder saves the order, then errors on the push', async () => {
    await api.update('_User', w.manager.id, { language: 'de' });
    const before = await api.find('Order', {});
    const res = await api.fn(
      'placeOrder',
      {
        userId: w.customer.id,
        restaurantId: w.storeId,
        userAddressId: w.addressId,
        foodIds: [w.foodId],
        deliveryType: 'delivery',
        type: 'food',
        options: {},
        distance: 1,
        duration: 1,
      },
      w.customer.session,
    );
    expect(res.body.code).toBe(141);
    expect(await api.find('Order', {})).toHaveLength(before.length + 1);
    await api.update('_User', w.manager.id, { language: 'en' });
  });
});
