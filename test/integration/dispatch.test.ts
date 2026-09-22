// Automatic dispatch (inventory §4) and Agenda 4.1.3 document compatibility (plan §6.6, J-1…J-6).
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { client, type Client, eventually, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeWorld, placeOrder, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;
const jobs = () => server.switchApp.mongo.db().collection('agendaJobs');
/** The next scheduled round (the short-lived "running" row has nextRunAt null). */
const scheduled = async (orderId: string) =>
  (await eventually(() => jobs().findOne({ 'data.objectId': orderId, nextRunAt: { $ne: null } })))!;

async function setConfig(params: Record<string, unknown>) {
  await api.request('PUT', '/config', { params }, { master: true });
}

/** Exactly what Agenda 4.1.3 `agenda.schedule('in 2 minutes', 'chooseDriver', data)` inserts. */
function legacyScheduledDoc(data: Record<string, unknown>, nextRunAt: Date) {
  return {
    name: 'chooseDriver',
    data,
    type: 'normal',
    priority: 0,
    nextRunAt,
    lastModifiedBy: null,
  };
}

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await setConfig({ driverRealtime: true, noDriverHandleAdmin: false, sendNotifsToAll: false });
});
afterAll(() => server?.close());
beforeEach(async () => {
  server.ports.reset();
  server.clock.now = undefined;
  await jobs().deleteMany({});
  // Park every driver from earlier tests.
  for (const d of await api.find('_User', { appType: 'driver' }))
    await api.update('_User', d.objectId as string, { driverActive: false });
});

describe('chooseDriver rounds', () => {
  it('widens 1 km at a time and notifies every driver found (Pusher when driverRealtime, FCM always)', async () => {
    await makeDriver(api, 2.5);
    const near = await makeDriver(api, 2.7);
    await makeDriver(api, 8); // outside the 6 km cap
    const orderId = await placeOrder(api, w);
    const staff = await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    expect(staff.body).toEqual({ result: 1 });
    await eventually(() => server.ports.effects.filter((e) => e.port === 'realtime').length === 2);
    const triggers = server.ports.effects.filter((e) => e.port === 'realtime').map((e) => e.args);
    expect(triggers).toEqual(
      expect.arrayContaining([[near.id, 'orderEvent', { data: { id: orderId } }]]),
    );
    expect(
      triggers.every(
        ([, event, payload]) =>
          event === 'orderEvent' &&
          JSON.stringify(payload) === JSON.stringify({ data: { id: orderId } }),
      ),
    ).toBe(true);
    // D-19: each of them also gets the FCM newOrder, for a driver whose socket is gone.
    const driverPushes = () =>
      server.ports.pushes().filter((p) => p.token?.startsWith('tok-driver-'));
    await eventually(() => driverPushes().length === 2);
    for (const push of driverPushes()) {
      expect(push.data).toEqual({
        id: orderId,
        newOrder: 'true',
        launchApp: 'true',
        playSound: 'true',
      });
    }
    expect(driverPushes().map((p) => p.token)).toEqual(
      expect.arrayContaining(['tok-driver-2.5', 'tok-driver-2.7']),
    );
    // Found at radius 3 km (iteration 2) → next round is iteration 3, in 2 minutes.
    const next = await scheduled(orderId);
    expect(next).toMatchObject({
      data: { iteration: 3, lastRun: false, calledDriver: null },
      type: 'normal',
      priority: 0,
    });
    const delay = (next.nextRunAt as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(115_000);
    expect(delay).toBeLessThanOrEqual(120_000);
  });

  it('exhausted search: extra lastRun round, then cancel + customer/manager/staff pushes', async () => {
    const orderId = await placeOrder(api, w);
    server.ports.reset();
    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    const lastRun = await scheduled(orderId);
    expect(lastRun.data).toEqual({
      objectId: orderId,
      iteration: 4,
      calledDriver: null,
      lastRun: true,
    });
    expect((await api.get('Order', orderId))!.canceled).toBe(false);

    // Time travel: make the pending round due, then let one worker scan pick it up.
    await jobs().updateOne(
      { _id: lastRun._id },
      { $set: { nextRunAt: new Date(Date.now() - 1000) } },
    );
    await server.switchApp.worker.scan();
    await eventually(async () => (await api.get('Order', orderId))!.canceled === true);
    await eventually(() => server.ports.pushes().length === 3);
    const byToken = Object.fromEntries(server.ports.pushes().map((p) => [p.token, p]));
    expect(byToken['tok-customer']).toEqual({
      android: { priority: 'high' },
      notification: {
        title: `Order #${orderId} was canceled because no driver is available, Please try again later.`,
      },
      data: { id: orderId, cancel: 'true', icon: 'error' },
      token: 'tok-customer',
    });
    expect(byToken['tok-manager']?.data).toEqual({ id: orderId, cancel: 'true', icon: 'error' });
    // Staff get the first clause only.
    expect(byToken['tok-staff']?.notification?.title).toBe(
      `Order #${orderId} was canceled because no driver is available`,
    );
    expect(await jobs().countDocuments({ 'data.objectId': orderId })).toBe(0);
  });

  it('noDriverHandleAdmin: the order stays open and staff get "Action required"', async () => {
    await setConfig({ noDriverHandleAdmin: true });
    const orderId = await placeOrder(api, w);
    await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: orderId, iteration: 4, calledDriver: null, lastRun: true },
        new Date(Date.now() - 1000),
      ),
    );
    server.ports.reset();
    await server.switchApp.worker.scan();
    await eventually(() => server.ports.pushes().length === 1);
    expect(server.ports.pushes()[0]?.notification?.title).toBe(
      `Order #${orderId} has no driver, Action required!`,
    );
    expect((await api.get('Order', orderId))!.canceled).toBe(false);
    await setConfig({ noDriverHandleAdmin: false });
  });

  it('exhausted search: a driver accepting before the cancel keeps the order, nobody is told (D-20)', async () => {
    const driver = await makeDriver(api, 40, { driverActive: false });
    const orderId = await placeOrder(api, w);
    await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: orderId, iteration: 4, calledDriver: null, lastRun: true },
        new Date(Date.now() - 1000),
      ),
    );
    // The driver accepts between the round's read of the order and its cancel.
    const { claims } = server.switchApp.deps;
    const cancelUnclaimed = claims.cancelUnclaimed.bind(claims);
    let accepted: unknown;
    const spy = vi.spyOn(claims, 'cancelUnclaimed').mockImplementationOnce(async (id) => {
      accepted = (await api.fn('acceptDriver', { objectId: orderId }, driver.session)).body;
      return cancelUnclaimed(id);
    });
    try {
      server.ports.reset();
      await server.switchApp.worker.scan();
      await eventually(() => spy.mock.results.length === 1);
      expect(await spy.mock.results[0]!.value).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(accepted).toEqual({ result: 1 });
    const order = (await api.get('Order', orderId))!;
    expect(order.canceled).toBe(false);
    expect(order.driver).toEqual(ptr('_User', driver.id));
    await new Promise((r) => setTimeout(r, 200));
    expect(server.ports.pushes()).toEqual([]);
  });

  it('stops when the order got a driver or was canceled meanwhile', async () => {
    const driver = await makeDriver(api, 0.5);
    const orderId = await placeOrder(api, w);
    await api.update('Order', orderId, { driver: ptr('_User', driver.id) });
    await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: orderId, iteration: 0, calledDriver: null, lastRun: false },
        new Date(Date.now() - 1000),
      ),
    );
    server.ports.reset();
    await server.switchApp.worker.scan();
    await eventually(async () => (await jobs().countDocuments({})) === 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.ports.effects).toEqual([]);
  });
});

describe('one send per driver from the search, ops unlimited (D-21)', () => {
  const offers = () => server.switchApp.mongo.db().collection('driverOffers');
  const fcmTo = (km: number) =>
    server.ports.pushes().filter((p) => p.token === `tok-driver-${km}`).length;
  const pusherTo = (driverId: string) =>
    server.ports.effects.filter((e) => e.port === 'realtime' && e.args[0] === driverId).length;
  /** Makes the pending round due, runs it, and waits for the round after it to be scheduled. */
  async function nextRound(orderId: string) {
    const pending = await scheduled(orderId);
    await jobs().updateOne(
      { _id: pending._id },
      { $set: { nextRunAt: new Date(Date.now() - 1000) } },
    );
    await server.switchApp.worker.scan();
    await eventually(() =>
      jobs().findOne({
        'data.objectId': orderId,
        nextRunAt: { $ne: null },
        _id: { $ne: pending._id },
      }),
    );
  }

  it('each round reaches new drivers but never sends a driver the same order twice', async () => {
    const first = await makeDriver(api, 0.31);
    const orderId = await placeOrder(api, w);
    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    await scheduled(orderId);
    await eventually(() => fcmTo(0.31) === 1 && pusherTo(first.id) === 1);

    const later = await makeDriver(api, 0.61);
    await nextRound(orderId);
    await eventually(() => fcmTo(0.61) === 1 && pusherTo(later.id) === 1);
    await nextRound(orderId);
    await new Promise((r) => setTimeout(r, 100));
    expect([fcmTo(0.31), pusherTo(first.id), fcmTo(0.61), pusherTo(later.id)]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('ops assign always sends, however often, and the search then skips that driver', async () => {
    const driver = await makeDriver(api, 0.32);
    const orderId = await placeOrder(api, w);
    for (let i = 0; i < 3; i++)
      expect(
        (await api.fn('assignDriver', { orderId, driverId: driver.id }, w.staffUser.session)).body,
      ).toEqual({ result: 1 });
    await eventually(() => fcmTo(0.32) === 3 && pusherTo(driver.id) === 3);
    // Every send replaces the previous tray entry instead of stacking another.
    for (const push of server.ports.pushes().filter((p) => p.token === 'tok-driver-0.32'))
      expect(push).toMatchObject({
        android: { notification: { tag: orderId } },
        apns: { headers: { 'apns-collapse-id': orderId } },
      });

    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    await scheduled(orderId); // the round found the driver and scheduled the next one
    await new Promise((r) => setTimeout(r, 100));
    expect([fcmTo(0.32), pusherTo(driver.id)]).toEqual([3, 3]);
  });

  it('a driver taking the order ends the offer: handed back, the others get it again', async () => {
    const other = await makeDriver(api, 0.33);
    const taker = await makeDriver(api, 0.34);
    const orderId = await placeOrder(api, w);
    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    await scheduled(orderId);
    await eventually(() => fcmTo(0.33) === 1 && fcmTo(0.34) === 1);

    await api.fn('acceptDriver', { objectId: orderId }, taker.session);
    await eventually(async () => (await offers().countDocuments({ orderId })) === 0);
    // Handed back without a reason: the search starts over, skipping the driver who quit.
    await api.fn('cancelDriver', { objectId: orderId }, taker.session);
    await eventually(() => fcmTo(0.33) === 2 && pusherTo(other.id) === 2);
    await scheduled(orderId);
    expect(fcmTo(0.34)).toBe(1);
  });

  it('the search giving up ends the offer', async () => {
    const orderId = await placeOrder(api, w);
    await server.switchApp.deps.offers.markOffered(orderId, 'someDriver');
    await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: orderId, iteration: 4, calledDriver: null, lastRun: true },
        new Date(Date.now() - 1000),
      ),
    );
    await server.switchApp.worker.scan();
    await eventually(async () => (await api.get('Order', orderId))!.canceled === true);
    await eventually(async () => (await offers().countDocuments({ orderId })) === 0);
  });

  it('of records racing for one driver and order, exactly one is first; clearing is per order', async () => {
    const { offers: store } = server.switchApp.deps;
    const firsts = await Promise.all(
      Array.from({ length: 10 }, () => store.markOffered('orderA', 'driverA')),
    );
    expect(firsts.filter(Boolean)).toHaveLength(1);
    await store.markOffered('orderAB', 'driverA');
    await store.clear('orderA');
    expect(
      await offers()
        .find({}, { projection: { _id: 1 } })
        .toArray(),
    ).toEqual(expect.arrayContaining([{ _id: 'orderAB:driverA' }]));
    expect(await offers().countDocuments({ orderId: 'orderA' })).toBe(0);
    expect(await store.markOffered('orderA', 'driverA')).toBe(true);
    // A non-string id clears nothing (it comes straight from a client on acceptDriver).
    await store.clear({ $ne: 'x' });
    expect(await offers().countDocuments({ orderId: 'orderAB' })).toBe(1);
  });
});

describe('Agenda 4.1.3 document compatibility', () => {
  it('J-1: runs a pending row written by legacy Agenda 4 (after locking it)', async () => {
    const driver = await makeDriver(api, 0.5);
    const orderId = await placeOrder(api, w);
    const { insertedId } = await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: orderId, iteration: 1, calledDriver: null, lastRun: false },
        new Date(Date.now() - 1000),
      ),
    );
    server.ports.reset();
    await server.switchApp.worker.scan();
    await eventually(() => server.ports.effects.some((e) => e.port === 'realtime'));
    expect(server.ports.effects.find((e) => e.port === 'realtime')?.args).toEqual([
      driver.id,
      'orderEvent',
      { data: { id: orderId } },
    ]);
    // The row it ran is gone; the next round is a fresh row.
    expect(await jobs().findOne({ _id: insertedId })).toBeNull();
    expect(await scheduled(orderId)).toMatchObject({ data: { iteration: 2 } });
  });

  it('J-2: rows v2 writes carry exactly the fields Agenda 4 reads', async () => {
    const orderId = await placeOrder(api, w);
    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    const row = await scheduled(orderId);
    expect(Object.keys(row).sort()).toEqual([
      '_id',
      'data',
      'lastModifiedBy',
      'name',
      'nextRunAt',
      'priority',
      'type',
    ]);
    expect(row.lockedAt).toBeUndefined(); // matches `lockedAt: { $eq: null }`
    expect(row.nextRunAt).toBeInstanceOf(Date);
  });

  it('J-3: starting dispatch again for the same order reuses its row (unique on data.objectId)', async () => {
    const orderId = await placeOrder(api, w);
    const orphan = await jobs().insertOne({
      name: 'chooseDriver',
      data: { objectId: orderId, iteration: 3 },
      type: 'normal',
      priority: 0,
      nextRunAt: null,
      lastModifiedBy: null,
    });
    await api.fn('chooseDriver', { orderId }, w.staffUser.session);
    // The orphan was upserted into the running row and then removed by the round itself.
    await eventually(async () => (await jobs().findOne({ _id: orphan.insertedId })) === null);
    await scheduled(orderId);
    const rows = await jobs().find({ 'data.objectId': orderId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ iteration: 4, lastRun: true });
  });

  it('J-4: acceptDriver cancels by partial data match, like agenda.cancel', async () => {
    const driver = await makeDriver(api, 0.5);
    const orderId = await placeOrder(api, w);
    await jobs().insertMany([
      legacyScheduledDoc(
        { objectId: orderId, iteration: 2, calledDriver: 'x', lastRun: false },
        new Date(Date.now() + 60_000),
      ),
      { name: 'chooseDriver', data: { objectId: orderId }, nextRunAt: null },
      legacyScheduledDoc({ objectId: 'other-order', iteration: 0 }, new Date(Date.now() + 60_000)),
    ]);
    await api.fn('acceptDriver', { objectId: orderId }, driver.session);
    expect(await jobs().countDocuments({ 'data.objectId': orderId })).toBe(0);
    expect(await jobs().countDocuments({ 'data.objectId': 'other-order' })).toBe(1);
  });

  it('J-5: legacy orphans (nextRunAt null, unlocked) are never run', async () => {
    const orderId = await placeOrder(api, w);
    await jobs().insertOne({
      name: 'chooseDriver',
      data: { objectId: orderId, iteration: 0 },
      type: 'normal',
      priority: 0,
      nextRunAt: null,
      lastRunAt: new Date(0),
      lastModifiedBy: null,
    });
    server.ports.reset();
    await server.switchApp.worker.scan();
    await new Promise((r) => setTimeout(r, 150));
    expect(
      await jobs().countDocuments({ 'data.objectId': orderId, lockedAt: { $exists: false } }),
    ).toBe(1);
    expect(server.ports.effects).toEqual([]);
  });

  it('J-6: a lock older than 10 minutes is taken over; a fresh lock and future rows are not', async () => {
    const orderId = await placeOrder(api, w);
    const now = Date.now();
    const stale = await jobs().insertOne({
      ...legacyScheduledDoc(
        { objectId: orderId, iteration: 0, calledDriver: null, lastRun: false },
        new Date(now - 700_000),
      ),
      lockedAt: new Date(now - 601_000),
    });
    const fresh = await jobs().insertOne({
      ...legacyScheduledDoc({ objectId: 'fresh', iteration: 0 }, new Date(now - 1000)),
      lockedAt: new Date(now - 30_000),
    });
    const future = await jobs().insertOne(
      legacyScheduledDoc({ objectId: 'future', iteration: 0 }, new Date(now + 60_000)),
    );
    const locked = await server.switchApp.agendaStore.findAndLockNext(
      'chooseDriver',
      new Date(now),
      new Date(now + 5000),
    );
    expect(locked?._id).toEqual(stale.insertedId);
    expect(
      await server.switchApp.agendaStore.findAndLockNext(
        'chooseDriver',
        new Date(now),
        new Date(now + 5000),
      ),
    ).toBeNull();
    expect((await jobs().findOne({ _id: fresh.insertedId }))?.lockedAt).toEqual(
      new Date(now - 30_000),
    );
    expect((await jobs().findOne({ _id: future.insertedId }))?.lockedAt).toBeUndefined();
    await jobs().deleteMany({});
  });

  it('D-15: stopping the worker releases the locks it holds', async () => {
    const { insertedId } = await jobs().insertOne(
      legacyScheduledDoc(
        { objectId: new ObjectId().toHexString(), iteration: 0 },
        new Date(Date.now() + 3000),
      ),
    );
    await server.switchApp.worker.scan(); // locks it (due within the 5 s scan window), waits to run
    expect((await jobs().findOne({ _id: insertedId }))?.lockedAt).toBeInstanceOf(Date);
    await server.switchApp.worker.stop();
    expect((await jobs().findOne({ _id: insertedId }))?.lockedAt).toBeNull();
  });
});
