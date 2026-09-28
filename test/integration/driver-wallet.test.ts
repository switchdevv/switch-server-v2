// D-25: drivers' prepaid wallets (ADR 0003). Spec: switch-finance/docs/driver-wallet-backend.md.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeDriver, makeUser, makeWorld, placeOrder, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;
let admin: { id: string; session: string };
let member: { id: string; session: string };
let otherStaff: { id: string; session: string };

const FEES = { initial: 150, minKms: 3, perExtraKm: 30, service: 50, servicePickup: 20 };

async function setFee(service: number) {
  await api.update('City', w.cityId, {
    currency: 'dzd',
    fees: { food: { ...FEES, service }, driver: FEES, manager: FEES },
  });
}

async function setWallet(settings: Record<string, unknown> | null) {
  await api.request('PUT', '/config', { params: { driverWallet: settings } }, { master: true });
}

let km = 1;
const newDriver = (fields: Record<string, unknown> = {}) =>
  makeDriver(api, (km += 0.01), { city: w.city, fullname: `Driver ${km.toFixed(2)}`, ...fields });

type Session = { session: string };

async function call<T = Record<string, unknown>>(
  name: string,
  params: Record<string, unknown>,
  who: Session,
) {
  const res = await api.fn(name, params, who.session);
  if (res.body.code) throw new Error(`${name}: ${res.body.code} ${res.body.error}`);
  return res.body.result as T;
}

const topUp = (driverId: string, orders: number, extra: Record<string, unknown> = {}) =>
  call<{ entry: { id: string }; summary: Summary }>(
    'recordWalletTopUp',
    { driverId, orders, method: 'cash', requestId: randomUUID(), ...extra },
    member,
  );

interface Summary {
  units: number;
  ordersLeft: number;
  value: number;
  unitPriceToday: number | null;
  level: string;
  closedAt: string | null;
}

async function ledger(driverId: string) {
  const result = await call<{
    ledger: { summary: Summary; lines: Record<string, unknown>[] } | null;
  }>('getDriverWallet', { driverId }, member);
  return result.ledger!;
}
const units = async (driverId: string) => (await ledger(driverId)).summary.units;

/** An order placed now, delivered by `driver` through the app's own finishDriver. */
async function deliver(driver: Session & { id: string }, options: Record<string, unknown> = {}) {
  const orderId = await placeOrder(api, w, {
    options: {
      itemsTotal: 800,
      service: 50,
      delivery: 150,
      freeDelivery: false,
      paymentMethod: 'cash',
      ...options,
    },
  });
  await api.update('Order', orderId, { driver: ptr('_User', driver.id), status: 2 });
  const res = await api.fn('finishDriver', { objectId: orderId }, driver.session);
  expect(res.body).toEqual({ result: 1 });
  return orderId;
}

const driverPushes = (driverId: string) =>
  server.ports.pushes().filter((p) => p.token === `tok-${driverId}`);

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
  await setFee(50);
  admin = w.staffUser;
  member = await makeUser(api, { appType: ['staff'], staffType: 'Staff', financeAccess: true });
  otherStaff = await makeUser(api, { appType: ['staff'], staffType: 'Staff' });
});
afterAll(() => server?.close());
beforeEach(async () => {
  server.ports.reset();
  await setWallet(null);
  await setFee(50);
});

describe('top-ups', () => {
  it('opens the wallet on the first one, at today’s fee in the driver’s city', async () => {
    const driver = await newDriver();
    expect(await call('getDriverWallet', { driverId: driver.id }, member)).toMatchObject({
      pricing: { unitPriceToday: 50, currency: 'dzd' },
      ledger: null,
    });
    const { summary } = await topUp(driver.id, 50);
    expect(summary).toMatchObject({
      units: 5000,
      ordersLeft: 50,
      value: 2500,
      unitPriceToday: 50,
      currency: 'dzd',
      level: 'ok',
    });
    const [line] = (await ledger(driver.id)).lines;
    expect(line).toMatchObject({
      type: 'entry',
      kind: 'topup',
      units: 5000,
      unitPrice: 50,
      amount: 2500,
      method: 'cash',
      by: { id: member.id },
    });
  });

  it('records a retried request once, and refuses its id for something else', async () => {
    const driver = await newDriver();
    const requestId = randomUUID();
    const params = { driverId: driver.id, orders: 10, method: 'cash', requestId };
    await call('recordWalletTopUp', params, member);
    await call('recordWalletTopUp', params, member);
    expect(await units(driver.id)).toBe(1000);
    const other = await newDriver();
    const res = await api.fn(
      'recordWalletTopUp',
      { ...params, driverId: other.id },
      member.session,
    );
    expect(res.body).toEqual({ code: 142, error: 'WALLET_REQUEST_REUSED' });
  });

  it('confirms to the driver in orders, whether or not the wallet is enforced', async () => {
    const driver = await newDriver({ pushToken: { driver: 'tok-topup' } });
    await topUp(driver.id, 5);
    const push = await eventually(() => server.ports.pushes().find((p) => p.token === 'tok-topup'));
    expect(push).toMatchObject({
      notification: { title: '5 orders added', body: 'You now have 5 orders.' },
      data: { wallet: 'refresh', icon: 'success' },
      android: { notification: { tag: 'wallet' } },
    });
  });

  it('refuses what is not a driver, or a driver without a city or a fee', async () => {
    const r = (driverId: string) =>
      api.fn(
        'recordWalletTopUp',
        { driverId, orders: 1, method: 'cash', requestId: randomUUID() },
        member.session,
      );
    expect((await r('nope')).body).toEqual({ code: 101, error: 'WALLET_DRIVER_NOT_FOUND' });
    expect((await r(w.customer.id)).body).toEqual({ code: 142, error: 'WALLET_NOT_A_DRIVER' });
    const noCity = await makeDriver(api, 9);
    expect((await r(noCity.id)).body).toEqual({ code: 142, error: 'WALLET_NO_CITY' });
    await setFee(0);
    const driver = await newDriver();
    expect((await r(driver.id)).body).toEqual({ code: 142, error: 'WALLET_NO_SERVICE_FEE' });
  });

  it('checks its params (102)', async () => {
    const driver = await newDriver();
    const base = { driverId: driver.id, orders: 1, method: 'cash', requestId: randomUUID() };
    for (const bad of [
      { orders: 0 },
      { orders: 1.5 },
      { orders: -2 },
      { method: 'card' },
      { requestId: 'x' },
      { startsAt: 'not a date' },
      { startsAt: new Date(Date.now() + 86400e3).toISOString() },
    ]) {
      const res = await api.fn('recordWalletTopUp', { ...base, ...bad }, member.session);
      expect(res.body, JSON.stringify(bad)).toEqual({ code: 102, error: 'WALLET_INVALID_PARAMS' });
    }
  });
});

describe('deliveries', () => {
  it('takes one order per ordinary delivery, and only the driver’s own from the start', async () => {
    const driver = await newDriver();
    const other = await newDriver();
    const before = await deliver(driver); // before the wallet starts
    expect(before).toBeTruthy();
    await topUp(driver.id, 10);
    await topUp(other.id, 10);
    await deliver(driver);
    await deliver(driver);
    await deliver(other);
    // Not delivered yet: doesn't count.
    const onTheWay = await placeOrder(api, w, { options: { service: 50, paymentMethod: 'cash' } });
    await api.update('Order', onTheWay, { driver: ptr('_User', driver.id), status: 2 });
    expect(await units(driver.id)).toBe(800);
    expect(await units(other.id)).toBe(900);
    const { lines } = await ledger(driver.id);
    expect(lines.filter((l) => l.type === 'order')).toEqual([
      expect.objectContaining({ units: -100, price: 50, balanceAfter: 800 }),
      expect.objectContaining({ units: -100, price: 50, balanceAfter: 900 }),
    ]);
  });

  it('gives back the delivery fee Switch owes on a free delivery, in orders at its price', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 10);
    // 50 − 150 = −100 DA → +2 orders.
    await deliver(driver, { freeDelivery: true, delivery: 150 });
    expect(await units(driver.id)).toBe(1200);
    // A free-everything promo: no service fee, so today's city fee prices the 150 DA: +3.
    await deliver(driver, { service: 0, freeDelivery: true, delivery: 150 });
    expect(await units(driver.id)).toBe(1500);
    // No service fee and no free delivery: nothing either way.
    await deliver(driver, { service: 0 });
    expect(await units(driver.id)).toBe(1500);
    // A delivery fee that isn't a whole number of orders: hundredths.
    await deliver(driver, { freeDelivery: true, delivery: 130 });
    expect(await units(driver.id)).toBe(1660);
  });

  it('keeps the price orders were bought at when the fee changes', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 50); // 2,500 DA at 50
    await setFee(60);
    for (let i = 0; i < 3; i++) await deliver(driver, { service: 60 });
    // 60 − 180 = −120 DA at 60 → +2 orders, worth 60 each.
    await deliver(driver, { service: 60, freeDelivery: true, delivery: 180 });
    const { summary } = await ledger(driver.id);
    expect(summary).toMatchObject({ units: 4900, ordersLeft: 49, unitPriceToday: 60 });
    expect(summary.value).toBe(2 * 60 + 47 * 50);
  });
});

describe('changes to a delivered order', () => {
  it('follows status, cancel, money, the driver and deletion, and notes each on the ledger', async () => {
    const a = await newDriver();
    const b = await newDriver();
    await topUp(a.id, 10);
    await topUp(b.id, 10);
    const orderId = await deliver(a);
    expect(await units(a.id)).toBe(900);

    const edit = (params: Record<string, unknown>) =>
      call('editOrder', { id: orderId, ...params }, w.staffUser);
    const notes = async (driverId: string) =>
      (await ledger(driverId)).lines.filter((l) => l.kind === 'orderChange');
    /** Runs `change`, then waits for the ledger note it leaves (written in the background). */
    const noteAfter = async (driverId: string, change: () => Promise<unknown>) => {
      const seen = new Set((await notes(driverId)).map((l) => l.id));
      await change();
      const note = await eventually(async () =>
        (await notes(driverId)).find((l) => !seen.has(l.id)),
      );
      return note!;
    };

    for (const status of [2, 1, 0]) {
      await edit({ status });
      expect(await units(a.id), `status ${status}`).toBe(1000);
      await edit({ status: 3 });
      expect(await units(a.id)).toBe(900);
    }
    expect(await noteAfter(a.id, () => edit({ status: 2 }))).toMatchObject({
      counted: false,
      units: 0,
      order: { id: orderId, change: 'status', from: 3, to: 2, effect: 100 },
      by: { id: w.staffUser.id },
    });
    await edit({ status: 3 });

    await edit({ canceled: true });
    expect(await units(a.id)).toBe(1000);
    await edit({ canceled: false });
    expect(await units(a.id)).toBe(900);

    const money = await noteAfter(a.id, () => edit({ options: { freeDelivery: true } }));
    expect(money.order).toMatchObject({ change: 'money', effect: 300 });
    expect(await units(a.id)).toBe(1200);
    await edit({ options: { freeDelivery: false } });

    // To another driver (a Parse Dashboard edit: no staff function, no note, same balances).
    await api.update('Order', orderId, { driver: ptr('_User', b.id) });
    expect(await units(a.id)).toBe(1000);
    expect(await units(b.id)).toBe(900);

    // Ops handing it on through assignDriver: off b.
    const handedOn = await noteAfter(b.id, () =>
      call('assignDriver', { orderId, driverId: a.id }, w.staffUser),
    );
    expect(await units(b.id)).toBe(1000);
    expect(handedOn.order).toMatchObject({
      change: 'reassigned',
      from: b.id,
      to: null,
      effect: 100,
    });

    await api.update('Order', orderId, { driver: ptr('_User', a.id) });
    expect(await units(a.id)).toBe(900);
    const deleted = await noteAfter(a.id, () =>
      call('deleteOrders', { ids: [orderId] }, w.staffUser),
    );
    expect(deleted.order).toMatchObject({ change: 'deleted', effect: 100 });
    expect(await units(a.id)).toBe(1000);
  });
});

describe('refunds, adjustments and voids', () => {
  it('pays back the oldest orders at what they cost, and can close the wallet', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 10); // at 50
    await setFee(60);
    await topUp(driver.id, 10); // at 60
    await deliver(driver, { service: 60 }); // uses one bought at 50
    const refund = (params: Record<string, unknown>) =>
      api.fn(
        'recordWalletRefund',
        { driverId: driver.id, requestId: randomUUID(), ...params },
        member.session,
      );
    expect((await refund({ orders: 20 })).body).toEqual({
      code: 142,
      error: 'WALLET_REFUND_EXCEEDS_BALANCE',
    });
    // The oldest 4 left are at 50: previewed first, then recorded.
    const preview = await api.fn(
      'recordWalletRefund',
      { driverId: driver.id, orders: 4, dryRun: true },
      member.session,
    );
    expect(preview.body.result).toEqual({ preview: { units: -400, amount: 200 } });
    expect(await units(driver.id)).toBe(1900);
    const partial = (await refund({ orders: 4 })).body.result as {
      entry: { amount: number; units: number };
    };
    expect(partial.entry).toMatchObject({ units: -400, amount: 200 });
    const all = (await refund({ close: true })).body.result as {
      entry: { amount: number };
      summary: Summary;
    };
    expect(all.entry.amount).toBe(5 * 50 + 10 * 60);
    expect(all.summary).toMatchObject({ units: 0, value: 0 });
    expect(all.summary.closedAt).toEqual(expect.any(String));
    expect((await refund({})).body).toEqual({ code: 142, error: 'WALLET_NOTHING_TO_REFUND' });
    // A top-up opens it again.
    expect((await topUp(driver.id, 1)).summary.closedAt).toBeNull();
  });

  it('lets admins add orders with or without cash value, take some away, and void', async () => {
    const driver = await newDriver();
    const { entry } = await topUp(driver.id, 10);
    const adjust = (params: Record<string, unknown>, who: Session = admin) =>
      api.fn(
        'recordWalletAdjustment',
        { driverId: driver.id, requestId: randomUUID(), reason: 'test', ...params },
        who.session,
      );
    expect((await adjust({ orders: 5 }, member)).body).toEqual({
      code: 119,
      error: 'ADMIN_REQUIRED',
    });
    expect((await adjust({ orders: 5 })).body.code).toBeUndefined(); // at 50
    expect((await adjust({ orders: 5, unitPrice: 0 })).body.code).toBeUndefined();
    expect((await adjust({ orders: 1 }, member)).body.code).toBe(119);
    expect((await adjust({ orders: 2, reason: '' })).body.code).toBe(102);
    let summary = (await ledger(driver.id)).summary;
    // Newest first: 5 free, then 5 at 50, then 10 at 50.
    expect(summary).toMatchObject({ units: 2000, value: 750 });
    expect((await adjust({ orders: -12 })).body.code).toBeUndefined();
    summary = (await ledger(driver.id)).summary;
    expect(summary).toMatchObject({ units: 800, value: 150 });

    const voidEntry = (entryId: string, who: Session = admin) =>
      api.fn('voidWalletEntry', { entryId, reason: 'typo' }, who.session);
    expect((await voidEntry(entry.id, member)).body.code).toBe(119);
    expect((await voidEntry(entry.id)).body.code).toBeUndefined();
    expect(await units(driver.id)).toBe(-200);
    expect((await voidEntry(entry.id)).body).toEqual({ code: 142, error: 'WALLET_ENTRY_VOIDED' });
    const voided = (await ledger(driver.id)).lines.find((l) => l.id === entry.id);
    expect(voided).toMatchObject({ counted: false, voided: { reason: 'typo' } });
  });
});

describe('the online gate', () => {
  const goOnline = (who: Session & { id: string }, fields: Record<string, unknown> = {}) =>
    api.request(
      'PUT',
      `/users/${who.id}`,
      { driverActive: true, ...fields },
      { session: who.session },
    );

  it('refuses going online with too few orders only while enforced', async () => {
    const driver = await newDriver({ driverActive: false });
    expect((await goOnline(driver)).status).toBe(200);
    await api.update('_User', driver.id, { driverActive: false });
    await setWallet({ enforced: true, minOrders: 1, lowOrders: 10 });
    expect((await goOnline(driver)).body).toEqual({ code: 142, error: 'WALLET_EMPTY' });
    expect((await api.get('_User', driver.id))!.driverActive).toBe(false);
    // Saves that don't turn it on are untouched; master writes are never refused.
    const move = await api.request(
      'PUT',
      `/users/${driver.id}`,
      { language: 'fr' },
      { session: driver.session },
    );
    expect(move.status).toBe(200);
    await api.update('_User', driver.id, { driverActive: true });
    await api.update('_User', driver.id, { driverActive: false });

    await topUp(driver.id, 1);
    expect((await goOnline(driver)).status).toBe(200);
    await setWallet({ enforced: true, minOrders: 3, lowOrders: 10 });
    expect((await goOnline(driver)).body.code).toBe(142);
  });

  it('starts a new account offline instead of refusing its signup', async () => {
    await setWallet({ enforced: true });
    const driver = await newDriver({ driverActive: true });
    expect((await api.get('_User', driver.id))!.driverActive).toBe(false);
  });

  it('tells the driver app orders, never money', async () => {
    const driver = await newDriver();
    const mine = () => call<Record<string, unknown>>('getMyWallet', {}, driver);
    expect(await mine()).toEqual({
      enforced: false,
      state: 'off',
      ordersLeft: 0,
      canGoOnline: true,
      minOrders: 1,
      lowOrders: 10,
      hasWallet: false,
    });
    await setWallet({ enforced: true, minOrders: 1, lowOrders: 10 });
    expect(await mine()).toMatchObject({ state: 'empty', canGoOnline: false });
    await topUp(driver.id, 12);
    expect(await mine()).toEqual({
      enforced: true,
      state: 'ok',
      ordersLeft: 12,
      canGoOnline: true,
      minOrders: 1,
      lowOrders: 10,
      hasWallet: true,
    });
  });
});

describe('rules by region', () => {
  let oranId: string;
  const oran = () => ptr('City', oranId);

  beforeAll(async () => {
    oranId = await api.create('City', {
      name: 'Oran',
      currency: 'dzd',
      fees: { food: { ...FEES, service: 40 }, driver: FEES, manager: FEES },
    });
  });

  const goOnline = (who: Session & { id: string }) =>
    api.request('PUT', `/users/${who.id}`, { driverActive: true }, { session: who.session });

  it('enforces nothing anywhere while the global switch is off, whatever a region says', async () => {
    await setWallet({ enforced: false, regions: { [w.cityId]: { enforced: true } } });
    const alger = await newDriver({ driverActive: false });
    const oranDriver = await newDriver({ driverActive: false, city: oran() });
    expect((await goOnline(alger)).status).toBe(200);
    expect((await goOnline(oranDriver)).status).toBe(200);
    expect(await call('getMyWallet', {}, alger)).toMatchObject({ enforced: false, state: 'off' });
  });

  it('enforces every region, and a driver with none, once the global switch is on', async () => {
    await setWallet({ enforced: true });
    const alger = await newDriver({ driverActive: false });
    const nowhere = await makeDriver(api, 7, { driverActive: false });
    expect((await goOnline(alger)).body).toEqual({ code: 142, error: 'WALLET_EMPTY' });
    expect((await goOnline(nowhere)).body.code).toBe(142);
  });

  it('leaves a region out of a global switch', async () => {
    await setWallet({ enforced: true, regions: { [w.cityId]: { enforced: false } } });
    const alger = await newDriver({ driverActive: false });
    const oranDriver = await newDriver({ driverActive: false, city: oran() });
    expect((await goOnline(alger)).status).toBe(200);
    expect((await goOnline(oranDriver)).body.code).toBe(142);
  });

  it('holds a driver to their region’s thresholds, the global ones where it sets none', async () => {
    await setWallet({
      enforced: true,
      minOrders: 1,
      lowOrders: 10,
      regions: { [w.cityId]: { minOrders: 3, lowOrders: 5 } },
    });
    const alger = await newDriver({ driverActive: false });
    await topUp(alger.id, 2);
    expect((await goOnline(alger)).body.code).toBe(142);
    expect(await call('getMyWallet', {}, alger)).toMatchObject({
      state: 'empty',
      minOrders: 3,
      lowOrders: 5,
      ordersLeft: 2,
    });
    const oranDriver = await newDriver({ driverActive: false, city: oran() });
    await topUp(oranDriver.id, 2);
    expect((await goOnline(oranDriver)).status).toBe(200);
    expect(await call('getMyWallet', {}, oranDriver)).toMatchObject({
      state: 'low',
      minOrders: 1,
      lowOrders: 10,
    });
  });

  it('tells finance the rules, and which wallets are held to them', async () => {
    const config = {
      enforced: true,
      minOrders: 1,
      lowOrders: 10,
      regions: { [oranId]: { enforced: false } },
    };
    await setWallet(config);
    const alger = await newDriver();
    const oranDriver = await newDriver({ city: oran() });
    await topUp(alger.id, 1);
    await topUp(oranDriver.id, 1);
    const list = await call<{
      config: unknown;
      wallets: { driverId: string; enforced: boolean }[];
    }>('listDriverWallets', {}, member);
    expect(list.config).toEqual(config);
    const byId = new Map(list.wallets.map((wallet) => [wallet.driverId, wallet]));
    expect(byId.get(alger.id)?.enforced).toBe(true);
    expect(byId.get(oranDriver.id)?.enforced).toBe(false);
    const detail = await call<{ settings: unknown }>(
      'getDriverWallet',
      { driverId: alger.id },
      member,
    );
    expect(detail.settings).toEqual({ enforced: true, minOrders: 1, lowOrders: 10 });
  });
});

describe('the driver’s own history', () => {
  type Line = Record<string, unknown> & { id: string; cursor: string; kind: string };
  interface History {
    hasWallet: boolean;
    lines: Line[];
    next: string | null;
    recent: Record<string, unknown> | null;
  }
  const history = (who: Session, params: Record<string, unknown> = {}) =>
    call<History>('getMyWalletHistory', params, who);
  const LINE_KEYS = [
    'cursor',
    'id',
    'kind',
    'at',
    'units',
    'counted',
    'voided',
    'balanceAfter',
    'method',
    'orderId',
    'freeDelivery',
    'paidInCash',
    'change',
  ].sort();

  it('is empty without a wallet', async () => {
    const driver = await newDriver();
    expect(await history(driver)).toEqual({
      hasWallet: false,
      lines: [],
      next: null,
      recent: null,
    });
  });

  it('lists every movement newest first, in orders only', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 10, { reference: 'R-1', note: 'at the office' });
    const cash = await deliver(driver);
    const free = await deliver(driver, { freeDelivery: true, delivery: 150 }); // 50 − 150: +2
    const card = await deliver(driver, { paymentMethod: 'creditcards', delivery: 150 }); // +3
    await call(
      'recordWalletRefund',
      { driverId: driver.id, orders: 1, requestId: randomUUID() },
      member,
    );
    const adjusted = await call<{ entry: { id: string } }>(
      'recordWalletAdjustment',
      { driverId: driver.id, orders: 5, reason: 'bonus', requestId: randomUUID() },
      admin,
    );
    await call('voidWalletEntry', { entryId: adjusted.entry.id, reason: 'typo' }, admin);
    // Ops re-open the cash delivery: its line leaves, and a note says what it gave back.
    await call('editOrder', { id: cash, status: 2 }, w.staffUser);
    const result = (await eventually(async () => {
      const h = await history(driver);
      return h.lines.some((l) => l.kind === 'orderChange') ? h : undefined;
    }))!;

    expect(result.hasWallet).toBe(true);
    expect(result.next).toBeNull();
    expect(result.lines.map((l) => [l.kind, l.units, l.counted, l.voided, l.balanceAfter])).toEqual(
      [
        ['orderChange', 100, false, false, 1400],
        ['adjustment', 500, false, true, 1400],
        ['refund', -100, true, false, 1400],
        ['delivery', 300, true, false, 1500],
        ['delivery', 200, true, false, 1200],
        ['topup', 1000, true, false, 1000],
      ],
    );
    const [note, , , cardLine, freeLine, topUpLine] = result.lines;
    expect(note).toMatchObject({ orderId: cash, change: 'status' });
    expect(cardLine).toMatchObject({ orderId: card, paidInCash: false, freeDelivery: false });
    expect(freeLine).toMatchObject({ orderId: free, paidInCash: true, freeDelivery: true });
    expect(topUpLine).toMatchObject({ method: 'cash', orderId: null });
    // No price, amount, reference, staff name or note: the driver app never shows money.
    for (const line of result.lines) expect(Object.keys(line).sort()).toEqual(LINE_KEYS);
    expect(result.recent).toMatchObject({ deliveries: 2, used: 0, added: 1500 });
    expect(await call('getMyWallet', {}, driver)).toMatchObject({
      hasWallet: true,
      ordersLeft: 14,
    });
  });

  it('pages without repeating or skipping a line, even one gone since', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 10);
    for (let i = 0; i < 4; i++) await deliver(driver);
    const first = await history(driver, { limit: 2 });
    expect(first.recent).toMatchObject({ deliveries: 4, used: 400, added: 1000 });
    expect(first.next).toBe(first.lines[1]!.cursor);
    const second = await history(driver, { limit: 2, before: first.next });
    expect(second.recent).toBeNull();
    const third = await history(driver, { limit: 2, before: second.next });
    expect(third.next).toBeNull();
    const all = [...first.lines, ...second.lines, ...third.lines];
    expect(all.map((l) => l.kind)).toEqual([
      'delivery',
      'delivery',
      'delivery',
      'delivery',
      'topup',
    ]);
    expect(new Set(all.map((l) => l.id)).size).toBe(5);

    // The last line held is canceled in the meantime: the next page starts from its time.
    await api.update('Order', first.lines[1]!.id, { canceled: true });
    const again = await history(driver, { limit: 2, before: first.next });
    expect(again.lines.map((l) => l.id)).toEqual(second.lines.map((l) => l.id));
  });

  it('checks its params (102) and needs a session', async () => {
    const driver = await newDriver();
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { before: 'nope' },
      { before: 12 },
    ]) {
      const res = await api.fn('getMyWalletHistory', bad, driver.session);
      expect(res.body, JSON.stringify(bad)).toEqual({ code: 102, error: 'WALLET_INVALID_PARAMS' });
    }
    expect((await api.fn('getMyWalletHistory', {})).body.code).toBeDefined();
  });
});

describe('alerts', () => {
  it('warns once at the threshold, once when out, and takes an empty driver offline', async () => {
    await setWallet({ enforced: true, minOrders: 1, lowOrders: 2 });
    const driver = await newDriver();
    await api.update('_User', driver.id, { pushToken: { driver: `tok-${driver.id}` } });
    await topUp(driver.id, 3);
    await eventually(() => driverPushes(driver.id).length === 1); // the top-up's
    server.ports.reset();

    await deliver(driver); // 2 left: low
    const low = await eventually(() => driverPushes(driver.id)[0]);
    expect(low).toMatchObject({
      notification: { title: 'Only 2 orders left' },
      data: { wallet: 'refresh', icon: 'alert' },
    });
    await deliver(driver); // 1 left: still low, no second warning
    await deliver(driver); // 0 left: empty
    const empty = await eventually(() => driverPushes(driver.id)[1]);
    expect(empty).toMatchObject({
      notification: { title: 'No orders left' },
      data: { wallet: 'refresh', icon: 'error' },
    });
    expect(driverPushes(driver.id)).toHaveLength(2);

    // Online anyway (a master write): a refund-style change takes them offline.
    await api.update('_User', driver.id, { driverActive: true });
    await topUp(driver.id, 1);
    await api.update('_User', driver.id, { driverActive: true });
    await call(
      'recordWalletRefund',
      { driverId: driver.id, requestId: randomUUID(), close: true },
      member,
    );
    await eventually(async () => (await api.get('_User', driver.id))!.driverActive === false);
  });

  it('sends nothing while the wallet is not enforced, except the top-up receipt', async () => {
    const driver = await newDriver();
    await api.update('_User', driver.id, { pushToken: { driver: `tok-${driver.id}` } });
    await topUp(driver.id, 1);
    await eventually(() => driverPushes(driver.id).length === 1);
    await deliver(driver);
    await new Promise((r) => setTimeout(r, 200));
    expect(driverPushes(driver.id)).toHaveLength(1);
  });
});

describe('who may', () => {
  it('lets finance members and admins read and record, and nobody else', async () => {
    const driver = await newDriver();
    await topUp(driver.id, 1);
    const list = (who?: Session) => api.fn('listDriverWallets', {}, who?.session);
    expect((await list(member)).body.result).toMatchObject({
      config: { enforced: false, regions: {} },
      wallets: expect.arrayContaining([expect.objectContaining({ driverId: driver.id })]),
    });
    expect((await list(admin)).body.code).toBeUndefined();
    expect((await list(otherStaff)).body).toEqual({ code: 119, error: 'FINANCE_REQUIRED' });
    expect((await list(driver)).body).toEqual({ code: 119, error: 'FINANCE_REQUIRED' });
    expect((await list()).body.code).toBe(209);
    const disabled = await makeUser(api, {
      appType: ['staff'],
      staffType: 'Staff',
      financeAccess: true,
    });
    await api.update('_User', disabled.id, { enabled: false });
    expect((await list(disabled)).body.code).toBe(119);
    const res = await api.fn(
      'recordWalletTopUp',
      { driverId: driver.id, orders: 1, method: 'cash', requestId: randomUUID() },
      otherStaff.session,
    );
    expect(res.body.code).toBe(119);
  });
});
