// D-23: a driver declining an order they were sent, and ops' private Pusher channels.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeUser, makeWorld, placeOrder, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;

const opsTriggers = () =>
  server.ports.effects
    .filter((e) => e.port === 'realtime' && e.args[1] === 'driverDeclined')
    .map((e) => e.args);

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await api.request('PUT', '/config', { params: { driverRealtime: true } }, { master: true });
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

describe('declineDriver', () => {
  it('stores each decline under its driver and tells ops on the all and region channels', async () => {
    const driver = await makeDriver(api, 1.1, { fullname: 'Karim B' });
    const orderId = await placeOrder(api, w);
    await api.fn('assignDriver', { orderId, driverId: driver.id }, w.staffUser.session);

    const res = await api.fn('declineDriver', { objectId: orderId }, driver.session);
    expect(res.body).toEqual({});

    const order = (await api.get('Order', orderId))!;
    const declines = order.driverDeclines as Record<string, { name: string; at: string }>;
    expect(declines).toEqual({ [driver.id]: { name: 'Karim B', at: expect.any(String) } });
    await eventually(() => opsTriggers().length === 2);
    const payload = {
      orderId,
      driverId: driver.id,
      driverName: 'Karim B',
      cityId: w.cityId,
      declinedAt: declines[driver.id]!.at,
    };
    expect(opsTriggers()).toEqual(
      expect.arrayContaining([
        ['private-ops', 'driverDeclined', payload],
        [`private-ops-city-${w.cityId}`, 'driverDeclined', payload],
      ]),
    );
  });

  it('keeps every driver who declined at once, and forgets only the one sent it again', async () => {
    const drivers = await Promise.all(
      [1.6, 1.7, 1.8, 1.9, 2.0].map((km) => makeDriver(api, km, { fullname: `D${km}` })),
    );
    const orderId = await placeOrder(api, w);
    for (const d of drivers)
      await api.fn('assignDriver', { orderId, driverId: d.id }, w.staffUser.session);
    await Promise.all(
      drivers.map((d) => api.fn('declineDriver', { objectId: orderId }, d.session)),
    );
    const declined = async () =>
      Object.keys((await api.get('Order', orderId))!.driverDeclines ?? {}).sort();
    expect(await declined()).toEqual(drivers.map((d) => d.id).sort());

    await api.fn('assignDriver', { orderId, driverId: drivers[0]!.id }, w.staffUser.session);
    expect(await declined()).toEqual(
      drivers
        .slice(1)
        .map((d) => d.id)
        .sort(),
    );
  });

  it('ignores a driver the order was never sent to', async () => {
    const stranger = await makeDriver(api, 1.2);
    const orderId = await placeOrder(api, w);
    const res = await api.fn('declineDriver', { objectId: orderId }, stranger.session);
    expect(res.body).toEqual({});
    expect((await api.get('Order', orderId))!.driverDeclines).toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(opsTriggers()).toHaveLength(0);
  });

  it('ignores an order another driver already took', async () => {
    const offered = await makeDriver(api, 1.3);
    const taker = await makeDriver(api, 1.4);
    const orderId = await placeOrder(api, w);
    await api.fn('assignDriver', { orderId, driverId: offered.id }, w.staffUser.session);
    await api.fn('acceptDriver', { objectId: orderId }, taker.session);
    await api.fn('declineDriver', { objectId: orderId }, offered.session);
    expect((await api.get('Order', orderId))!.driverDeclines).toBeUndefined();
    expect(opsTriggers()).toHaveLength(0);
  });
});

describe('authorizeOpsChannel', () => {
  const authorize = (session: string, channelName: string) =>
    api.fn('authorizeOpsChannel', { socketId: '123.456', channelName }, session);

  it('lets an admin join every channel', async () => {
    for (const channel of ['private-ops', 'private-ops-city-anyCity']) {
      const res = await authorize(w.staffUser.session, channel);
      expect(res.body).toEqual({ result: { auth: `fake:${channel}:123.456` } });
    }
  });

  it('confines granted staff to their own region, and refuses everyone else', async () => {
    const staff = await makeUser(api, {
      appType: ['staff'],
      staffType: 'Staff',
      opsAccess: true,
      city: w.city,
    });
    expect((await authorize(staff.session, `private-ops-city-${w.cityId}`)).body).toEqual({
      result: { auth: `fake:private-ops-city-${w.cityId}:123.456` },
    });
    for (const channel of ['private-ops', 'private-ops-city-otherCity', 'private-other']) {
      expect((await authorize(staff.session, channel)).body).toMatchObject({ code: 119 });
    }

    const ungranted = await makeUser(api, { appType: ['staff'], staffType: 'Staff', city: w.city });
    const driver = await makeDriver(api, 1.5, { city: w.city });
    for (const user of [ungranted, driver]) {
      expect((await authorize(user.session, `private-ops-city-${w.cityId}`)).body).toMatchObject({
        code: 119,
      });
    }
  });
});
