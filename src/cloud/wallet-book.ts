// The driver wallet's figures and side effects (D-25, ADR 0003), shared by the wallet functions,
// the `beforeSave _User` online gate, finishDriver and the staff order functions.
//
// Nothing here stores a balance. A wallet's orders are its manual entries plus its driver's
// delivered orders, read afresh each time, so an order ops cancel, re-open or hand to someone
// else moves the orders with it whoever changed it (a staff function, a REST save, the Parse
// Dashboard, the legacy server during the canary).
import { randomUUID } from 'node:crypto';
import {
  type Lot,
  ordersLeft,
  serviceFeeOf,
  UNITS_PER_ORDER,
  valueOfNewest,
  type WalletLevel,
  walletLevel,
  type WalletConfig,
  walletConfigOf,
  walletSettingsFor,
} from '../domain/driver-wallet.js';
import { languageOf } from '../domain/i18n.js';
import { walletPushCopy, type WalletPushKind } from '../domain/wallet-messages.js';
import type { CloudDeps, ParseUser } from './context.js';
import type {
  DriverWalletDoc,
  OrderChangeKind,
  OrderUnitRow,
  WalletActor,
  WalletEntryDoc,
  WalletWindow,
} from './driver-wallets.js';
import { sendPush } from './notify.js';

/** Config `driverWallet`: the global rules and each region's own (`walletSettingsFor` merges). */
export async function walletConfig(deps: CloudDeps): Promise<WalletConfig> {
  const config = await deps.Parse.Config.get();
  return walletConfigOf(config.get('driverWallet'));
}

/** What the wallet needs to know about a driver's account. */
export interface WalletDriver {
  id: string;
  name: string | null;
  isDriver: boolean;
  cityId: string | null;
  cityName: string | null;
  currency: string | null;
  /** Today's service fee in the driver's city (DA), or null. */
  fee: number | null;
  driverActive: boolean;
  language: string;
  pushToken: string | null;
  user: ParseUser;
}

export function actorOf(user: ParseUser): WalletActor {
  const name = (user.get('fullname') as string | undefined) || (user.get('username') as string);
  return { id: user.id!, name: name || null };
}

function toWalletDriver(user: ParseUser): WalletDriver {
  const city = user.get('city') as { id?: string; get?(key: string): unknown } | undefined;
  const loaded = city && typeof city.get === 'function';
  const appType = user.get('appType');
  return {
    id: user.id!,
    name: actorOf(user).name,
    isDriver: Array.isArray(appType) && appType.includes('driver'),
    cityId: city?.id ?? null,
    cityName: loaded ? ((city.get!('name') as string | undefined) ?? null) : null,
    currency: loaded ? ((city.get!('currency') as string | undefined) ?? null) : null,
    fee: loaded ? serviceFeeOf(city.get!('fees')) : null,
    driverActive: user.get('driverActive') === true,
    language: languageOf(user),
    pushToken:
      ((user.get('pushToken') as Record<string, string> | undefined)?.driver as string) || null,
    user,
  };
}

/** The accounts behind these ids, with their city, by id (missing ids are left out). */
export async function walletDrivers(
  deps: CloudDeps,
  ids: readonly string[],
): Promise<Map<string, WalletDriver>> {
  const { Parse } = deps;
  const drivers = new Map<string, WalletDriver>();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const users = await new Parse.Query(Parse.User)
      .containedIn('objectId', batch)
      .include('city')
      .limit(batch.length)
      .find({ useMasterKey: true });
    for (const user of users) drivers.set(user.id!, toWalletDriver(user));
  }
  return drivers;
}

const counts = (entry: WalletEntryDoc) => entry.voided === null && entry.kind !== 'orderChange';

function windowOf(wallet: DriverWalletDoc, driver: WalletDriver | undefined): WalletWindow {
  return { driverId: wallet._id, startsAt: wallet.startsAt, fee: driver?.fee ?? null };
}

/** The lots a balance is valued against, newest first: what added orders, at its price. */
function lotsOf(entries: readonly WalletEntryDoc[], credits: readonly OrderUnitRow[]): Lot[] {
  const lots: Lot[] = [];
  for (const entry of entries)
    if (counts(entry) && entry.units > 0)
      lots.push({ at: entry.at, units: entry.units, unitPrice: entry.unitPrice ?? 0 });
  for (const row of credits) lots.push({ at: row.at, units: row.change, unitPrice: row.price });
  return lots.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Everything a wallet's figures come from. */
export interface WalletBook {
  wallet: DriverWalletDoc;
  driver: WalletDriver | undefined;
  entries: WalletEntryDoc[];
  /** The balance, in hundredths of an order. */
  units: number;
  lots: Lot[];
}

async function booksFor(
  deps: CloudDeps,
  wallets: readonly DriverWalletDoc[],
  drivers: Map<string, WalletDriver>,
): Promise<WalletBook[]> {
  if (wallets.length === 0) return [];
  const windows = wallets.map((w) => windowOf(w, drivers.get(w._id)));
  const ids = wallets.map((w) => w._id);
  const [entries, totals, credits] = await Promise.all([
    deps.wallets.entries(ids),
    deps.wallets.orderTotals(windows),
    deps.wallets.orderRows(windows, { credits: true }),
  ]);
  return wallets.map((wallet) => {
    const own = entries.filter((e) => e.driverId === wallet._id);
    const ownCredits = credits.filter((r) => r.driverId === wallet._id);
    const units =
      own.filter(counts).reduce((sum, e) => sum + e.units, 0) + (totals.get(wallet._id) ?? 0);
    return {
      wallet,
      driver: drivers.get(wallet._id),
      entries: own,
      units,
      lots: lotsOf(own, ownCredits),
    };
  });
}

/** One driver's book, or null when they have no wallet. */
export async function walletBook(deps: CloudDeps, driverId: string): Promise<WalletBook | null> {
  const wallet = await deps.wallets.wallet(driverId);
  if (!wallet) return null;
  const drivers = await walletDrivers(deps, [driverId]);
  const [book] = await booksFor(deps, [wallet], drivers);
  return book!;
}

/**
 * A driver's balance in hundredths of an order: 0 without a wallet. Only the sums, no lots: what
 * the online gate and the driver app need.
 */
export async function walletUnits(
  deps: CloudDeps,
  driverId: string,
  driver?: WalletDriver,
): Promise<number> {
  const wallet = await deps.wallets.wallet(driverId);
  if (!wallet) return 0;
  const known = driver ?? (await walletDrivers(deps, [driverId])).get(driverId);
  const window = windowOf(wallet, known);
  const [entries, totals] = await Promise.all([
    deps.wallets.entries([driverId]),
    deps.wallets.orderTotals([window]),
  ]);
  return entries.filter(counts).reduce((sum, e) => sum + e.units, 0) + (totals.get(driverId) ?? 0);
}

/** A wallet as switch-finance lists it. Dates are ISO strings. */
export interface WalletSummary {
  driverId: string;
  startsAt: string;
  closedAt: string | null;
  /** Hundredths of an order. */
  units: number;
  ordersLeft: number;
  /** DA the orders left are worth at what was paid for them; negative: the driver owes. */
  value: number;
  unitPriceToday: number | null;
  currency: string | null;
  level: WalletLevel;
  /** Whether the rules for this driver's region hold them to it right now. */
  enforced: boolean;
  lastTopUp: { at: string; orders: number; amount: number } | null;
}

export function summaryOf(book: WalletBook, config: WalletConfig): WalletSummary {
  const fee = book.driver?.fee ?? null;
  const settings = walletSettingsFor(config, book.driver?.cityId ?? null);
  const lastTopUp = book.entries.find((e) => e.kind === 'topup' && e.voided === null);
  return {
    driverId: book.wallet._id,
    startsAt: book.wallet.startsAt.toISOString(),
    closedAt: book.wallet.closedAt ? book.wallet.closedAt.toISOString() : null,
    units: book.units,
    ordersLeft: ordersLeft(book.units),
    value: valueOfNewest(book.lots, book.units, fee ?? 0),
    unitPriceToday: fee,
    currency: book.driver?.currency ?? null,
    level: walletLevel(book.units, settings),
    enforced: settings.enforced,
    lastTopUp: lastTopUp
      ? {
          at: lastTopUp.at.toISOString(),
          orders: lastTopUp.units / UNITS_PER_ORDER,
          amount: lastTopUp.amount,
        }
      : null,
  };
}

export async function walletSummaries(
  deps: CloudDeps,
  config: WalletConfig,
): Promise<WalletSummary[]> {
  const wallets = await deps.wallets.wallets();
  const drivers = await walletDrivers(
    deps,
    wallets.map((w) => w._id),
  );
  const books = await booksFor(deps, wallets, drivers);
  return books.map((book) => summaryOf(book, config));
}

// ---------------------------------------------------------------------------------------------
// The ledger

export interface LedgerEntryLine {
  type: 'entry';
  id: string;
  kind: WalletEntryDoc['kind'];
  at: string;
  units: number;
  /** Whether it is in the balance: not voided, and not an order-change note. */
  counted: boolean;
  unitPrice: number | null;
  amount: number;
  method: WalletEntryDoc['method'];
  reference: string | null;
  note: string | null;
  by: WalletActor;
  voided: { at: string; by: WalletActor; reason: string } | null;
  order: WalletEntryDoc['order'];
  balanceAfter: number;
}

export interface LedgerOrderLine {
  type: 'order';
  id: string;
  at: string;
  units: number;
  price: number;
  freeDelivery: boolean;
  balanceAfter: number;
}

export type LedgerLine = LedgerEntryLine | LedgerOrderLine;

export interface WalletLedger {
  summary: WalletSummary;
  range: {
    from: string;
    to: string;
    openingUnits: number;
    closingUnits: number;
    /** Hundredths of an order the deliveries used, and gave back. */
    used: number;
    credited: number;
    deliveries: number;
    toppedUp: { units: number; amount: number };
    refunded: { units: number; amount: number };
  };
  /** Newest first. */
  lines: LedgerLine[];
  truncated: boolean;
}

export const LEDGER_LINE_LIMIT = 3000;

/** A movement of a wallet, with the balance (hundredths) right after it. */
type Walked =
  | { at: Date; balanceAfter: number; entry: WalletEntryDoc }
  | { at: Date; balanceAfter: number; row: OrderUnitRow };

/**
 * Every movement of a wallet, oldest first, with the balance after each: its entries and its
 * driver's counted orders, walked once. The one running balance behind finance's ledger and the
 * driver's history.
 */
async function walkBook(deps: CloudDeps, book: WalletBook): Promise<Walked[]> {
  const rows = await deps.wallets.orderRows([windowOf(book.wallet, book.driver)]);
  const events = [
    ...book.entries.map((entry) => ({
      at: entry.at,
      units: counts(entry) ? entry.units : 0,
      entry,
    })),
    ...rows.map((row) => ({ at: row.at, units: row.change, row })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  let balance = 0;
  return events.map(({ units, ...event }) => {
    balance += units;
    return { ...event, balanceAfter: balance };
  });
}

/** A wallet's movements in `[from, to]` with the balance after each, and the range's totals. */
export async function walletLedger(
  deps: CloudDeps,
  config: WalletConfig,
  book: WalletBook,
  from: Date,
  to: Date,
): Promise<WalletLedger> {
  const events = await walkBook(deps, book);

  let opening = 0;
  const range = {
    used: 0,
    credited: 0,
    deliveries: 0,
    toppedUp: { units: 0, amount: 0 },
    refunded: { units: 0, amount: 0 },
  };
  const lines: LedgerLine[] = [];
  for (const event of events) {
    const balance = event.balanceAfter;
    if (event.at < from) {
      opening = balance;
      continue;
    }
    if (event.at > to) continue;
    if ('row' in event) {
      const { row } = event;
      range.deliveries += 1;
      if (row.change < 0) range.used -= row.change;
      else range.credited += row.change;
      lines.push({
        type: 'order',
        id: row.orderId,
        at: row.at.toISOString(),
        units: row.change,
        price: row.price,
        freeDelivery: row.freeDelivery,
        balanceAfter: balance,
      });
      continue;
    }
    const { entry } = event;
    if (counts(entry) && entry.kind === 'topup') {
      range.toppedUp.units += entry.units;
      range.toppedUp.amount += entry.amount;
    }
    if (counts(entry) && entry.kind === 'refund') {
      range.refunded.units -= entry.units;
      range.refunded.amount += entry.amount;
    }
    lines.push({
      type: 'entry',
      id: entry._id,
      kind: entry.kind,
      at: entry.at.toISOString(),
      units: entry.units,
      counted: counts(entry),
      unitPrice: entry.unitPrice,
      amount: entry.amount,
      method: entry.method,
      reference: entry.reference,
      note: entry.note,
      by: entry.by,
      voided: entry.voided
        ? { at: entry.voided.at.toISOString(), by: entry.voided.by, reason: entry.voided.reason }
        : null,
      order: entry.order,
      balanceAfter: balance,
    });
  }
  const closing = lines.length ? lines[lines.length - 1]!.balanceAfter : opening;
  lines.reverse();
  return {
    summary: summaryOf(book, config),
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      openingUnits: opening,
      closingUnits: closing,
      ...range,
    },
    lines: lines.slice(0, LEDGER_LINE_LIMIT),
    truncated: lines.length > LEDGER_LINE_LIMIT,
  };
}

// ---------------------------------------------------------------------------------------------
// The driver's own history

/**
 * One movement as the driver app shows it: orders only. No price, amount, reference, staff name
 * or staff note — the driver app never shows money, and notes are written for finance.
 */
export interface MyWalletLine {
  /** Where the next page starts when this is the last line held (`before`). */
  cursor: string;
  id: string;
  kind: 'topup' | 'refund' | 'adjustment' | 'delivery' | 'orderChange';
  at: string;
  /**
   * Hundredths of an order, + added, − used. A voided entry keeps what it moved; an
   * `orderChange` carries what the change gave back (+) or took (−), already in the balance
   * through the order itself.
   */
  units: number;
  /** Whether `units` is in the balance: false for a voided entry and for an `orderChange`. */
  counted: boolean;
  voided: boolean;
  /** The balance right after it, hundredths. */
  balanceAfter: number;
  /** Top-ups: how the driver paid. */
  method: WalletEntryDoc['method'];
  /** Deliveries and order changes. */
  orderId: string | null;
  /** Deliveries: what decided what the order did. */
  freeDelivery: boolean;
  paidInCash: boolean | null;
  /** Order changes: what staff changed on the order. */
  change: OrderChangeKind | null;
}

export interface MyWalletHistory {
  lines: MyWalletLine[];
  /** The `before` of the next page, or null on the last one. */
  next: string | null;
}

const cursorOf = (at: Date, id: string) => `${at.getTime()}.${id}`;

function myLine(event: Walked): MyWalletLine | null {
  if ('row' in event) {
    const { row } = event;
    return {
      cursor: cursorOf(row.at, row.orderId),
      id: row.orderId,
      kind: 'delivery',
      at: row.at.toISOString(),
      units: row.change,
      counted: true,
      voided: false,
      balanceAfter: event.balanceAfter,
      method: null,
      orderId: row.orderId,
      freeDelivery: row.freeDelivery,
      paidInCash: row.money.paymentMethod === 'cash',
      change: null,
    };
  }
  const { entry } = event;
  const note = entry.kind === 'orderChange';
  // A note whose change moved nothing (a fee edit that left the charge alone) says nothing.
  if (note && !entry.order?.effect) return null;
  return {
    cursor: cursorOf(entry.at, entry._id),
    id: entry._id,
    kind: entry.kind,
    at: entry.at.toISOString(),
    units: note ? entry.order!.effect : entry.units,
    counted: counts(entry),
    voided: entry.voided !== null,
    balanceAfter: event.balanceAfter,
    method: entry.method,
    orderId: entry.order?.id ?? null,
    freeDelivery: false,
    paidInCash: null,
    change: entry.order?.change ?? null,
  };
}

/**
 * A page of the driver's own history, newest first: `limit` lines older than the line whose
 * cursor is `before` (from the newest without it). A line gone since (an order ops canceled)
 * leaves the page to start from its time instead.
 */
export async function walletHistory(
  deps: CloudDeps,
  book: WalletBook,
  opts: { before: string | null; limit: number },
): Promise<MyWalletHistory> {
  const events = await walkBook(deps, book);
  const lines: MyWalletLine[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const line = myLine(events[i]!);
    if (line) lines.push(line);
  }

  let start = 0;
  if (opts.before) {
    const held = lines.findIndex((line) => line.cursor === opts.before);
    if (held >= 0) start = held + 1;
    else {
      const at = Number(opts.before.slice(0, opts.before.indexOf('.')));
      start = lines.findIndex((line) => Date.parse(line.at) < at);
      if (start < 0) start = lines.length;
    }
  }
  const page = lines.slice(start, start + opts.limit);
  const more = start + page.length < lines.length;
  return {
    lines: page,
    next: more && page.length > 0 ? page[page.length - 1]!.cursor : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Side effects: alerts, the push, going offline

const PUSH_ICONS: Record<WalletPushKind, string> = {
  // Names every installed driver build already knows (switch-driver ui/Message/Message.js):
  // an unknown `data.icon` crashes an app (see the note on staff `sendPush`).
  low: 'alert',
  empty: 'error',
  topUp: 'success',
};

function pushWallet(
  deps: CloudDeps,
  driver: WalletDriver,
  kind: WalletPushKind,
  left: number,
  added = 0,
): void {
  if (!driver.pushToken) return;
  const copy = walletPushCopy(driver.language, kind, left, added);
  // `wallet: 'refresh'` makes the driver app re-read `getMyWallet`; old builds just show it.
  sendPush(deps, {
    title: copy.title,
    body: copy.body,
    token: driver.pushToken,
    data: { wallet: 'refresh', icon: PUSH_ICONS[kind] },
    tag: 'wallet',
  });
}

/**
 * After anything that moved a wallet: warns the driver once per level (low, then empty) and
 * takes an empty wallet's driver offline. Only while the wallet is enforced — except a top-up's
 * confirmation, which is always sent: it is the driver's receipt.
 */
export async function afterWalletChange(
  deps: CloudDeps,
  driverId: string,
  opts: { added?: number } = {},
): Promise<void> {
  const wallet = await deps.wallets.wallet(driverId);
  if (!wallet) return;
  const [config, drivers] = await Promise.all([
    walletConfig(deps),
    walletDrivers(deps, [driverId]),
  ]);
  const driver = drivers.get(driverId);
  if (!driver) return;
  const settings = walletSettingsFor(config, driver.cityId);
  const units = await walletUnits(deps, driverId, driver);
  const level = walletLevel(units, settings);
  const left = ordersLeft(units);

  if (opts.added) {
    // The top-up's own push says how many are left: no low warning on top of it.
    await deps.wallets.setAlert(driverId, level);
    pushWallet(deps, driver, 'topUp', left, opts.added);
    return;
  }
  if (!settings.enforced) return;
  if (level === 'ok') {
    await deps.wallets.setAlert(driverId, 'ok');
    return;
  }
  if (level === 'empty' && driver.driverActive) {
    driver.user.set('driverActive', false);
    await driver.user.save(null, { useMasterKey: true });
  }
  if (await deps.wallets.claimAlert(driverId, level)) pushWallet(deps, driver, level, left);
}

// ---------------------------------------------------------------------------------------------
// Staff edits of an order

/**
 * An order as the wallets see it, read before a staff write: its driver and the orders it
 * counts for. Never throws — a failed read only costs finance the note on the ledger (the
 * balance follows the order regardless).
 */
export async function walletOrderBefore(
  deps: CloudDeps,
  orderId: unknown,
): Promise<OrderUnitRow | null> {
  if (typeof orderId !== 'string') return null;
  try {
    return await probe(deps, orderId, []);
  } catch (error) {
    deps.logger.warn({ err: error, orderId }, 'wallet: order not read before a staff edit');
    return null;
  }
}

/** Probes an order, priced with the fees of its driver and `driverIds` when it carries none. */
async function probe(
  deps: CloudDeps,
  orderId: string,
  driverIds: readonly (string | null | undefined)[],
): Promise<OrderUnitRow | null> {
  const row = await deps.wallets.probeOrder(orderId, []);
  if (!row || row.money.service > 0) return row;
  // No fee of its own: priced at today's fee in the city of each wallet it could count for.
  const ids = [...new Set([row.driverId, ...driverIds].filter((id): id is string => !!id))];
  const wallets = await deps.wallets.wallets(ids);
  if (wallets.length === 0) return row;
  const drivers = await walletDrivers(deps, ids);
  return deps.wallets.probeOrder(
    orderId,
    wallets.map((w) => windowOf(w, drivers.get(w._id))),
  );
}

function describeChange(
  before: OrderUnitRow,
  after: OrderUnitRow | null,
): { change: OrderChangeKind; from: unknown; to: unknown } | null {
  if (!after) return { change: 'deleted', from: before.status, to: null };
  if (before.driverId !== after.driverId)
    return { change: 'reassigned', from: before.driverId, to: after.driverId };
  if (before.canceled !== after.canceled)
    return { change: 'canceled', from: before.canceled, to: after.canceled };
  if (before.status !== after.status)
    return { change: 'status', from: before.status, to: after.status };
  const a = before.money;
  const b = after.money;
  if (
    a.service !== b.service ||
    a.delivery !== b.delivery ||
    a.freeDelivery !== b.freeDelivery ||
    a.paymentMethod !== b.paymentMethod
  )
    return { change: 'money', from: a, to: b };
  return null;
}

/**
 * After a staff write to an order: for each wallet the order counted for before or counts for
 * now, a note on the ledger saying what changed and what it gave back or took, then the alerts.
 * The balance itself needs nothing: it follows the order.
 */
export async function recordOrderChange(
  deps: CloudDeps,
  staff: ParseUser,
  orderId: string,
  before: OrderUnitRow | null,
): Promise<void> {
  if (!before) return;
  const after = await probe(deps, orderId, [before.driverId]);
  const ids = [...new Set([before.driverId, after?.driverId].filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const change = describeChange(before, after);
  if (!change) return;
  for (const wallet of await deps.wallets.wallets(ids)) {
    const driverId = wallet._id;
    const countsFor = (row: OrderUnitRow | null): row is OrderUnitRow =>
      !!row && row.driverId === driverId && row.counted && row.at >= wallet.startsAt;
    const was = countsFor(before);
    const is = countsFor(after);
    if (!was && !is) continue;
    const effect = (is ? after.change : 0) - (was ? before.change : 0);
    await deps.wallets.addEntry({
      _id: randomUUID(),
      driverId,
      kind: 'orderChange',
      units: 0,
      unitPrice: null,
      amount: 0,
      method: null,
      reference: null,
      note: null,
      by: actorOf(staff),
      order: { id: orderId, ...change, effect },
    });
    await afterWalletChange(deps, driverId);
  }
}
