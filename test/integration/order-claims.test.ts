// Who drives an order (D-20, ADR 0002): accepting, handing back and the no-driver cancel are each
// one atomic compare-and-set, so concurrent callers can never both win.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderDoc } from '../../src/cloud/order-claims.js';
import { client, type Client, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeWorld, placeOrder, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;
const orders = () => server.switchApp.mongo.db().collection<OrderDoc>('Order');

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await api.request(
    'PUT',
    '/config',
    { params: { driverRealtime: false, noDriverHandleAdmin: false, sendNotifsToAll: false } },
    { master: true },
  );
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

describe('acceptDriver', () => {
  it('drivers accepting one order at the same moment: exactly one wins', async () => {
    const drivers = await Promise.all(Array.from({ length: 8 }, (_, i) => makeDriver(api, 7 + i)));
    for (let round = 0; round < 10; round++) {
      const orderId = await placeOrder(api, w);
      const answers = await Promise.all(
        drivers.map((d) => api.fn('acceptDriver', { objectId: orderId }, d.session)),
      );
      const winners = drivers.filter((_, i) => answers[i]!.body.result === 1);
      expect(winners).toHaveLength(1);
      expect(answers.filter((a) => a.body.error === 'ORDER_FULLFILLED')).toHaveLength(7);
      const winner = winners[0]!;
      expect((await api.get('Order', orderId))!.driver).toEqual(ptr('_User', winner.id));
      // The driver app confirms with checkDriver: only the winner passes.
      const checks = await Promise.all(
        drivers.map((d) => api.fn('checkDriver', { objectId: orderId }, d.session)),
      );
      expect(checks.filter((c) => c.body.result === 1)).toHaveLength(1);
    }
  });

  it('accepting your own order again still answers 1', async () => {
    const driver = await makeDriver(api, 20);
    const orderId = await placeOrder(api, w);
    for (let i = 0; i < 2; i++)
      expect((await api.fn('acceptDriver', { objectId: orderId }, driver.session)).body).toEqual({
        result: 1,
      });
    expect((await api.get('Order', orderId))!.driver).toEqual(ptr('_User', driver.id));
  });

  it('a canceled order, an unknown id and a non-string id all answer ORDER_CANCELED', async () => {
    const driver = await makeDriver(api, 21);
    const canceled = await placeOrder(api, w);
    await api.update('Order', canceled, { canceled: true });
    const ids: unknown[] = [canceled, 'noSuchOrder', { $ne: 'x' }, { $exists: true }, [canceled]];
    for (const objectId of ids)
      expect((await api.fn('acceptDriver', { objectId }, driver.session)).body.error).toBe(
        'ORDER_CANCELED',
      );
    // A query operator never reaches the filter: no order got this driver.
    expect(await orders().countDocuments({ _p_driver: `_User$${driver.id}` })).toBe(0);
  });

  it("stores the driver exactly as Parse's own writes do", async () => {
    const driver = await makeDriver(api, 22);
    const claimed = await placeOrder(api, w);
    const byParse = await placeOrder(api, w);
    const before = (await orders().findOne({ _id: claimed }))!._updated_at!;

    await api.fn('acceptDriver', { objectId: claimed }, driver.session);
    await api.update('Order', byParse, { driver: ptr('_User', driver.id) });
    const raw = (await orders().findOne({ _id: claimed }))!;
    expect(raw._p_driver).toBe((await orders().findOne({ _id: byParse }))!._p_driver);
    expect(raw._p_driver).toBe(`_User$${driver.id}`);
    expect(raw._updated_at!.getTime()).toBeGreaterThan(before.getTime());
    expect((await api.get('Order', claimed))!.updatedAt).toBe(raw._updated_at!.toISOString());

    // Handing it back leaves what Parse leaves for `driver: null`.
    await api.fn('cancelDriver', { objectId: claimed, reason: 'flat tyre' }, driver.session);
    await api.update('Order', byParse, { driver: null });
    expect((await orders().findOne({ _id: claimed }))!._p_driver).toBeNull();
    expect((await orders().findOne({ _id: byParse }))!._p_driver).toBeNull();
    expect((await api.get('Order', claimed))!.driver).toBeUndefined();
  });
});

describe('cancelDriver', () => {
  it('a driver ops took off the order cannot hand back the new holder', async () => {
    const stale = await makeDriver(api, 23, { city: w.city });
    const holder = await makeDriver(api, 24, { city: w.city });
    const orderId = await placeOrder(api, w);
    await api.fn('acceptDriver', { objectId: orderId }, stale.session);
    // Ops unassign (switch-ops' plain REST save) and the order goes to another driver.
    await api.update('Order', orderId, { driver: null });
    await api.fn('acceptDriver', { objectId: orderId }, holder.session);
    server.ports.reset();

    for (const reason of ['wrong address', undefined]) {
      const res = await api.fn('cancelDriver', { objectId: orderId, reason }, stale.session);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    }
    expect((await api.get('Order', orderId))!.driver).toEqual(ptr('_User', holder.id));
    await new Promise((r) => setTimeout(r, 200));
    expect(server.ports.pushes()).toEqual([]);
    expect(
      await server.switchApp.mongo
        .db()
        .collection('agendaJobs')
        .countDocuments({ 'data.objectId': orderId }),
    ).toBe(0);
  });
});

describe('the no-driver cancel', () => {
  it('racing an accept: exactly one of them applies', async () => {
    const driver = await makeDriver(api, 25);
    const { claims } = server.switchApp.deps;
    for (let round = 0; round < 20; round++) {
      const orderId = await placeOrder(api, w);
      const [claim, canceled] = await Promise.all([
        claims.claim(orderId, driver.id),
        claims.cancelUnclaimed(orderId),
      ]);
      const raw = (await orders().findOne({ _id: orderId }))!;
      if (canceled) {
        expect(claim).toBe('canceled');
        expect(raw).toMatchObject({ canceled: true });
        expect(raw._p_driver ?? null).toBeNull();
      } else {
        expect(claim).toBe('claimed');
        expect(raw).toMatchObject({ canceled: false, _p_driver: `_User$${driver.id}` });
      }
    }
  });
});
