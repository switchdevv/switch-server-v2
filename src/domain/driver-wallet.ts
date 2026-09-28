// The driver wallet's pure rules (D-25, ADR 0003): settings, states and the FIFO valuation. The
// per-order rule — what a delivered order takes from or gives to a wallet — lives in one place
// only, the aggregation in src/cloud/driver-wallets.ts, so every balance and ledger line is
// computed by the same expression.
//
// A wallet counts **orders**, in hundredths (`units`), so a free-delivery credit of 2.6 orders is
// exact and no floating-point drift ever loses one. Orders are locked at purchase: a top-up is a
// lot of N orders at that day's service fee, and later fee changes never touch it.

/** Hundredths of an order in one order. */
export const UNITS_PER_ORDER = 100;

/** Parse Config `driverWallet`, as admins set it from switch-finance (through `updateConfigs`). */
export interface WalletSettings {
  /** Off: nothing is refused and no alert is pushed. Balances are still kept. */
  enforced: boolean;
  /** Going online needs at least this many orders. */
  minOrders: number;
  /** At or under this many orders, the driver is warned. */
  lowOrders: number;
}

export const DEFAULT_WALLET_SETTINGS: WalletSettings = {
  enforced: false,
  minOrders: 1,
  lowOrders: 10,
};

function wholeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Reads Config `driverWallet`; anything missing or malformed takes its default. */
export function walletSettingsOf(value: unknown): WalletSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    enforced: raw.enforced === true,
    minOrders: wholeNumber(raw.minOrders, DEFAULT_WALLET_SETTINGS.minOrders),
    lowOrders: wholeNumber(raw.lowOrders, DEFAULT_WALLET_SETTINGS.lowOrders),
  };
}

/** Where a balance stands, whether or not the wallet is enforced. */
export type WalletLevel = 'ok' | 'low' | 'empty';
/** What the driver app is told: `off` while the wallet isn't enforced. */
export type WalletState = WalletLevel | 'off';

export function walletLevel(units: number, settings: WalletSettings): WalletLevel {
  if (units < settings.minOrders * UNITS_PER_ORDER) return 'empty';
  if (units <= settings.lowOrders * UNITS_PER_ORDER) return 'low';
  return 'ok';
}

export function walletState(units: number, settings: WalletSettings): WalletState {
  return settings.enforced ? walletLevel(units, settings) : 'off';
}

/** Whole orders left, never below 0: what the driver app shows. */
export function ordersLeft(units: number): number {
  return Math.max(0, Math.floor(units / UNITS_PER_ORDER));
}

/**
 * Whether going online is allowed. Also true when the wallet isn't enforced, so the gate in
 * `beforeSave _User` and the driver app agree.
 */
export function canGoOnline(units: number, settings: WalletSettings): boolean {
  return !settings.enforced || units >= settings.minOrders * UNITS_PER_ORDER;
}

/**
 * Something that added orders to a wallet, at a price per order: a top-up, a positive
 * adjustment, or a free-delivery credit (priced at that order's service fee).
 */
export interface Lot {
  at: Date;
  /** Hundredths of an order, > 0. */
  units: number;
  /** DA per order; 0 for orders given with no cash value. */
  unitPrice: number;
}

/**
 * The money value of the newest `units` across `lots` (sorted newest first), unrounded.
 *
 * Orders are used oldest first (FIFO), so the orders a wallet still holds are always the newest
 * ones it received: walking the lots from the newest until the balance is covered prices exactly
 * the orders that are left, each at what was paid for it. A negative balance — the driver used
 * more than they held — is priced at `fallbackPrice` (today's fee), as is any part the lots
 * don't cover.
 */
function exactValueOfNewest(lots: readonly Lot[], units: number, fallbackPrice: number): number {
  if (units <= 0) return (units * fallbackPrice) / UNITS_PER_ORDER;
  let left = units;
  let value = 0;
  for (const lot of lots) {
    const take = Math.min(lot.units, left);
    value += (take * lot.unitPrice) / UNITS_PER_ORDER;
    left -= take;
    if (left === 0) break;
  }
  return value + (left * fallbackPrice) / UNITS_PER_ORDER;
}

/** What the orders left are worth in DA: a full refund. Negative means the driver owes Switch. */
export function valueOfNewest(lots: readonly Lot[], units: number, fallbackPrice: number): number {
  return Math.round(exactValueOfNewest(lots, units, fallbackPrice));
}

/**
 * What the oldest `take` of the `units` left are worth: a partial refund or a negative
 * adjustment takes the oldest orders, like a delivery does, so the ones left stay the newest.
 */
export function valueOfOldest(
  lots: readonly Lot[],
  units: number,
  take: number,
  fallbackPrice: number,
): number {
  return Math.round(
    exactValueOfNewest(lots, units, fallbackPrice) -
      exactValueOfNewest(lots, units - take, fallbackPrice),
  );
}

/** A city's delivery service fee (`City.fees.food.service`), or null when it has none. */
export function serviceFeeOf(fees: unknown): number | null {
  const food = (fees as { food?: { service?: unknown } } | undefined)?.food;
  const fee = Number(food?.service);
  return Number.isFinite(fee) && fee > 0 ? fee : null;
}
