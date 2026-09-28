// Not in legacy (D-25, ADR 0003): drivers' prepaid wallets. The driver app reads its own with
// `getMyWallet` (orders only, never money); switch-finance runs the rest. Spec:
// switch-finance/docs/driver-wallet-backend.md.
//
// switch-finance reads the error code and message, so these throw Parse.Errors: 209 without a
// session, 119 FINANCE_REQUIRED / ADMIN_REQUIRED, 102 WALLET_INVALID_PARAMS, 101 for a missing
// driver / wallet / entry, 142 for a refused wallet operation.
import {
  canGoOnline,
  ordersLeft,
  UNITS_PER_ORDER,
  valueOfOldest,
  walletState,
} from '../../domain/driver-wallet.js';
import { detach, type CloudDeps, type FunctionTable } from '../context.js';
import { TOP_UP_METHODS, type TopUpMethod, type WalletEntryDoc } from '../driver-wallets.js';
import { requireFinance, requireUser } from '../guards.js';
import {
  actorOf,
  afterWalletChange,
  summaryOf,
  walletBook,
  walletDrivers,
  walletLedger,
  walletSettings,
  walletSummaries,
  walletUnits,
} from '../wallet-book.js';

/** The most orders one request may move: far above any real top-up, it only stops typos. */
const MAX_ORDERS = 100_000;
/** How far back a wallet may start, when a manual balance is carried over. */
const MAX_START_AGE_MS = 366 * 24 * 3600e3;
/** The widest ledger range one call reads. */
const MAX_RANGE_MS = 400 * 24 * 3600e3;
const DAY_MS = 24 * 3600e3;

function fail(deps: CloudDeps, code: number, message: string): never {
  throw new deps.Parse.Error(code, message);
}

function badParams(deps: CloudDeps): never {
  fail(deps, deps.Parse.Error.INVALID_QUERY, 'WALLET_INVALID_PARAMS');
}

function refused(deps: CloudDeps, message: string): never {
  fail(deps, deps.Parse.Error.VALIDATION_ERROR, message);
}

function idParam(deps: CloudDeps, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) badParams(deps);
  return value;
}

/** A client-made request id (a UUID): the entry's key, so a retry is recorded once. */
function requestIdParam(deps: CloudDeps, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) badParams(deps);
  return value;
}

function ordersParam(deps: CloudDeps, value: unknown, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) badParams(deps);
  if (value === 0 || Math.abs(value) > MAX_ORDERS || (!allowNegative && value < 0)) badParams(deps);
  return value;
}

function textParam(deps: CloudDeps, value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) badParams(deps);
    return null;
  }
  if (typeof value !== 'string' || value.length > 500) badParams(deps);
  const text = value.trim();
  if (required && !text) badParams(deps);
  return text || null;
}

function dateParam(deps: CloudDeps, value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  const date = new Date(value as string);
  if (typeof value !== 'string' || Number.isNaN(date.getTime())) badParams(deps);
  return date;
}

/** The driver the request is about: an existing account holding the driver app. */
async function targetDriver(deps: CloudDeps, driverId: string) {
  const driver = (await walletDrivers(deps, [driverId])).get(driverId);
  if (!driver) fail(deps, deps.Parse.Error.OBJECT_NOT_FOUND, 'WALLET_DRIVER_NOT_FOUND');
  if (!driver.isDriver) refused(deps, 'WALLET_NOT_A_DRIVER');
  return driver;
}

async function existingBook(deps: CloudDeps, driverId: string) {
  const book = await walletBook(deps, driverId);
  if (!book) fail(deps, deps.Parse.Error.OBJECT_NOT_FOUND, 'WALLET_NOT_STARTED');
  return book;
}

/** The same request id sent for something else is a client bug, not a retry. */
function sameRequest(deps: CloudDeps, entry: WalletEntryDoc, driverId: string, kind: string) {
  if (entry.driverId !== driverId || entry.kind !== kind) refused(deps, 'WALLET_REQUEST_REUSED');
}

async function freshSummary(deps: CloudDeps, driverId: string) {
  const [settings, book] = await Promise.all([walletSettings(deps), walletBook(deps, driverId)]);
  return book ? summaryOf(book, settings) : null;
}

function entryResult(entry: WalletEntryDoc) {
  return {
    id: entry._id,
    kind: entry.kind,
    at: entry.at.toISOString(),
    units: entry.units,
    unitPrice: entry.unitPrice,
    amount: entry.amount,
    method: entry.method,
  };
}

export const driverWalletFunctions: FunctionTable = {
  /**
   * The signed-in driver's wallet, in orders: no amount of money is ever sent to the app.
   * `state` is `off` while the wallet isn't enforced, and the app then shows nothing.
   */
  async getMyWallet(req, deps) {
    const user = requireUser(req);
    const settings = await walletSettings(deps);
    const units = await walletUnits(deps, user.id!);
    return {
      enforced: settings.enforced,
      state: walletState(units, settings),
      ordersLeft: ordersLeft(units),
      canGoOnline: canGoOnline(units, settings),
      minOrders: settings.minOrders,
      lowOrders: settings.lowOrders,
    };
  },

  async listDriverWallets(req, deps) {
    await requireFinance(req, deps);
    const settings = await walletSettings(deps);
    return { settings, wallets: await walletSummaries(deps, settings) };
  },

  /** One wallet with its ledger for `[from, to]` (the last 30 days by default). */
  async getDriverWallet(req, deps) {
    await requireFinance(req, deps);
    const params = req.params as Record<string, unknown>;
    const driverId = idParam(deps, params.driverId);
    const to = dateParam(deps, params.to) ?? deps.wallets.now();
    const from = dateParam(deps, params.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from > to || to.getTime() - from.getTime() > MAX_RANGE_MS) badParams(deps);
    const settings = await walletSettings(deps);
    const book = await walletBook(deps, driverId);
    // Today's price is what a top-up would cost, wallet or not: the first one needs it too.
    const driver = book?.driver ?? (await walletDrivers(deps, [driverId])).get(driverId);
    const pricing = { unitPriceToday: driver?.fee ?? null, currency: driver?.currency ?? null };
    if (!book) return { settings, pricing, ledger: null };
    return { settings, pricing, ledger: await walletLedger(deps, settings, book, from, to) };
  },

  /**
   * Cash (or a transfer) received from a driver for `orders` orders, at today's service fee in
   * their city — the price those orders keep. Opens the wallet on the first one, counting the
   * driver's deliveries from `startsAt` (now by default; earlier to carry over a manual balance).
   */
  async recordWalletTopUp(req, deps) {
    const { user: staff } = await requireFinance(req, deps);
    const params = req.params as Record<string, unknown>;
    const driverId = idParam(deps, params.driverId);
    const orders = ordersParam(deps, params.orders);
    const requestId = requestIdParam(deps, params.requestId);
    if (!TOP_UP_METHODS.includes(params.method as TopUpMethod)) badParams(deps);
    const method = params.method as TopUpMethod;
    const reference = textParam(deps, params.reference);
    const note = textParam(deps, params.note);
    const now = deps.wallets.now();
    const startsAt = dateParam(deps, params.startsAt) ?? now;
    if (startsAt.getTime() > now.getTime() + 5 * 60e3) badParams(deps);
    if (now.getTime() - startsAt.getTime() > MAX_START_AGE_MS) badParams(deps);

    const driver = await targetDriver(deps, driverId);
    if (!driver.cityId) refused(deps, 'WALLET_NO_CITY');
    if (!driver.fee) refused(deps, 'WALLET_NO_SERVICE_FEE');

    await deps.wallets.open(driverId, startsAt, actorOf(staff));
    const { entry, created } = await deps.wallets.addEntry({
      _id: requestId,
      driverId,
      kind: 'topup',
      units: orders * UNITS_PER_ORDER,
      unitPrice: driver.fee,
      amount: orders * driver.fee,
      method,
      reference,
      note,
      by: actorOf(staff),
      order: null,
    });
    sameRequest(deps, entry, driverId, 'topup');
    if (created)
      detach(deps, 'wallet top-up', afterWalletChange(deps, driverId, { added: orders }));
    return { entry: entryResult(entry), summary: await freshSummary(deps, driverId) };
  },

  /**
   * Money paid back to a driver: all the orders left by default, or `orders` of them. The oldest
   * orders go first, each at what was paid for it. `close` (only with a full refund) marks the
   * wallet closed; a later top-up opens it again. `dryRun` records nothing and answers
   * `{ preview: { units, amount } }`: what finance is about to hand over.
   */
  async recordWalletRefund(req, deps) {
    const { user: staff } = await requireFinance(req, deps);
    const params = req.params as Record<string, unknown>;
    const driverId = idParam(deps, params.driverId);
    const dryRun = params.dryRun === true;
    const requestId = dryRun ? '' : requestIdParam(deps, params.requestId);
    const orders =
      params.orders === undefined || params.orders === null
        ? null
        : ordersParam(deps, params.orders);
    if (params.close !== undefined && typeof params.close !== 'boolean') badParams(deps);
    const close = params.close === true;
    if (close && orders !== null) badParams(deps);
    const note = textParam(deps, params.note);

    const book = await existingBook(deps, driverId);
    const already = dryRun ? null : await deps.wallets.entry(requestId);
    if (!already) {
      if (book.units <= 0) refused(deps, 'WALLET_NOTHING_TO_REFUND');
      if (orders !== null && orders * UNITS_PER_ORDER > book.units)
        refused(deps, 'WALLET_REFUND_EXCEEDS_BALANCE');
    }
    const take = orders === null ? book.units : orders * UNITS_PER_ORDER;
    const amount = valueOfOldest(book.lots, book.units, take, book.driver?.fee ?? 0);
    if (dryRun) return { preview: { units: -take, amount } };
    const { entry, created } = await deps.wallets.addEntry({
      _id: requestId,
      driverId,
      kind: 'refund',
      units: -take,
      unitPrice: null,
      amount,
      method: null,
      reference: null,
      note,
      by: actorOf(staff),
      order: null,
    });
    sameRequest(deps, entry, driverId, 'refund');
    if (created) {
      if (close) await deps.wallets.close(driverId);
      detach(deps, 'wallet refund', afterWalletChange(deps, driverId));
    }
    return { entry: entryResult(entry), summary: await freshSummary(deps, driverId) };
  },

  /**
   * Admin only: orders added (at `unitPrice`, today's fee by default, 0 for orders given with no
   * cash value) or taken away (the oldest first), with a reason.
   */
  async recordWalletAdjustment(req, deps) {
    const { user: staff } = await requireFinance(req, deps, 'admin');
    const params = req.params as Record<string, unknown>;
    const driverId = idParam(deps, params.driverId);
    const requestId = requestIdParam(deps, params.requestId);
    const orders = ordersParam(deps, params.orders, true);
    const reason = textParam(deps, params.reason, true);
    let unitPrice: number | null = null;
    if (params.unitPrice !== undefined && params.unitPrice !== null) {
      if (
        typeof params.unitPrice !== 'number' ||
        !Number.isInteger(params.unitPrice) ||
        params.unitPrice < 0
      )
        badParams(deps);
      unitPrice = params.unitPrice;
    }
    if (orders < 0 && unitPrice !== null) badParams(deps);

    const book = await existingBook(deps, driverId);
    const units = orders * UNITS_PER_ORDER;
    const fee = book.driver?.fee ?? 0;
    const price = orders > 0 ? (unitPrice ?? fee) : null;
    const amount = orders > 0 ? orders * price! : valueOfOldest(book.lots, book.units, -units, fee);
    const { entry, created } = await deps.wallets.addEntry({
      _id: requestId,
      driverId,
      kind: 'adjustment',
      units,
      unitPrice: price,
      amount,
      method: null,
      reference: null,
      note: reason,
      by: actorOf(staff),
      order: null,
    });
    sameRequest(deps, entry, driverId, 'adjustment');
    if (created) detach(deps, 'wallet adjustment', afterWalletChange(deps, driverId));
    return { entry: entryResult(entry), summary: await freshSummary(deps, driverId) };
  },

  /** Admin only: takes a wrong top-up, refund or adjustment out of the balance; it stays listed. */
  async voidWalletEntry(req, deps) {
    const { user: staff } = await requireFinance(req, deps, 'admin');
    const params = req.params as Record<string, unknown>;
    const entryId = requestIdParam(deps, params.entryId);
    const reason = textParam(deps, params.reason, true)!;
    const entry = await deps.wallets.entry(entryId);
    if (!entry) fail(deps, deps.Parse.Error.OBJECT_NOT_FOUND, 'WALLET_ENTRY_NOT_FOUND');
    if (entry.kind === 'orderChange') refused(deps, 'WALLET_ENTRY_NOT_VOIDABLE');
    if (!(await deps.wallets.voidEntry(entryId, actorOf(staff), reason)))
      refused(deps, 'WALLET_ENTRY_VOIDED');
    detach(deps, 'wallet void', afterWalletChange(deps, entry.driverId));
    return { summary: await freshSummary(deps, entry.driverId) };
  },
};
