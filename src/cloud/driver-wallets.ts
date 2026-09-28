import type { Collection, Document } from 'mongodb';
import type { WalletLevel } from '../domain/driver-wallet.js';
import type { DriverWallets } from './context.js';

/**
 * The driver wallet's storage (D-25, ADR 0003): plain MongoDB collections next to `driverOffers`,
 * not Parse classes, so no client can read or write them — every access goes through the
 * finance-guarded cloud functions and `getMyWallet`.
 */
export const DRIVER_WALLETS_COLLECTION = 'driverWallets';
export const DRIVER_WALLET_ENTRIES_COLLECTION = 'driverWalletEntries';

/** Who did something: the staff account's id and name at the time. */
export interface WalletActor {
  id: string;
  name: string | null;
}

/** One per driver who has a wallet. Only orders created from `startsAt` on count. */
export interface DriverWalletDoc {
  /** The driver's `_User` objectId. */
  _id: string;
  startsAt: Date;
  createdAt: Date;
  createdBy: WalletActor;
  /** Set by a refund that closed the wallet; a later top-up opens it again. */
  closedAt: Date | null;
  /** The last level the driver was warned about, so each push goes out once. */
  alert: WalletLevel;
  alertAt: Date | null;
}

export type WalletEntryKind = 'topup' | 'refund' | 'adjustment' | 'orderChange';
export const TOP_UP_METHODS = ['cash', 'transfer', 'carriedOver'] as const;
export type TopUpMethod = (typeof TOP_UP_METHODS)[number];
export type OrderChangeKind = 'status' | 'canceled' | 'reassigned' | 'money' | 'deleted';

/**
 * A manual movement, or a note that staff changed a delivered order. Never deleted: a wrong one
 * is voided, which leaves it on the ledger and out of every balance.
 */
export interface WalletEntryDoc {
  /** The client's request id (a UUID), so a retried request records the entry once. */
  _id: string;
  driverId: string;
  kind: WalletEntryKind;
  /** Hundredths of an order, counted in the balance. Always 0 for `orderChange`. */
  units: number;
  /** DA per order for what the entry adds; null when it takes orders away. */
  unitPrice: number | null;
  /**
   * DA: paid in for a top-up, paid back for a refund, and for an adjustment what it adds or
   * takes away at the orders' prices. Always ≥ 0; the direction is `units`'.
   */
  amount: number;
  method: TopUpMethod | null;
  reference: string | null;
  note: string | null;
  at: Date;
  by: WalletActor;
  voided: { at: Date; by: WalletActor; reason: string } | null;
  /** `orderChange` only: what changed on the order, and the orders it gave back (+) or took (−). */
  order: {
    id: string;
    change: OrderChangeKind;
    from: unknown;
    to: unknown;
    /** Hundredths; informational, the balance already follows the order. */
    effect: number;
  } | null;
}

export type NewWalletEntry = Omit<WalletEntryDoc, 'at' | 'voided'>;

/** Which of a driver's orders count: from `startsAt`, priced with `fee` when they carry none. */
export interface WalletWindow {
  driverId: string;
  startsAt: Date;
  /** Today's service fee in the driver's city (DA), or null. */
  fee: number | null;
}

/** A delivered order as a wallet sees it. */
export interface OrderUnitRow {
  orderId: string;
  driverId: string | null;
  /** The order's `createdAt`: `Order` has no delivered-at column. */
  at: Date;
  /** Hundredths of an order the wallet changes by: −100 for an ordinary delivery. */
  change: number;
  /** DA per order it was priced at: its own service fee, else `fee`; 0 when neither exists. */
  price: number;
  freeDelivery: boolean;
  /** Delivered (status ≥ 3) and not canceled. */
  counted: boolean;
  status: unknown;
  canceled: boolean;
  money: { service: number; delivery: number; freeDelivery: boolean; paymentMethod: unknown };
}

const DUPLICATE_KEY = 11000;
const driverRef = (driverId: string) => `_User$${driverId}`;
const driverIdOf = (ref: unknown) =>
  typeof ref === 'string' && ref.startsWith('_User$') ? ref.slice('_User$'.length) : null;

/**
 * **The one implementation of what a delivered order does to a wallet**, as aggregation stages
 * over `Order` in Parse's storage format. The money rule is switch-dashboard's per-driver formula
 * (src/pages/Orders/Orders.jsx:371-376), as switch-ops transcribes it in
 * src/lib/ops/driver-settlement.ts:45-52:
 *
 *   paid in cash:  freeDelivery ? service − delivery : service
 *   otherwise:     −delivery
 *
 * — positive means the driver collected money that is Switch's. A wallet counts orders, so that
 * amount is divided by the order's price: its own `options.service` (the fee of the day it was
 * placed, which is what makes orders locked at purchase), or, for an order that carried none (a
 * `freeall` promo), today's fee in the driver's city. An ordinary delivery is exactly one order;
 * a free delivery whose fee is worth three orders gives back two. Missing amounts count as 0.
 */
function unitStages(windows: readonly WalletWindow[]): Document[] {
  const refs = windows.map((w) => driverRef(w.driverId));
  const fees = windows.map((w) => w.fee ?? 0);
  const amount = (path: string) => ({
    $convert: { input: path, to: 'double', onError: 0, onNull: 0 },
  });
  return [
    {
      $project: {
        driver: '$_p_driver',
        at: '$_created_at',
        status: '$status',
        canceled: { $eq: ['$canceled', true] },
        paymentMethod: '$options.paymentMethod',
        service: amount('$options.service'),
        delivery: amount('$options.delivery'),
        freeDelivery: { $eq: ['$options.freeDelivery', true] },
      },
    },
    {
      $addFields: {
        charge: {
          $cond: [
            { $eq: ['$paymentMethod', 'cash'] },
            {
              $cond: ['$freeDelivery', { $subtract: ['$service', '$delivery'] }, '$service'],
            },
            { $multiply: [-1, '$delivery'] },
          ],
        },
        cityFee: {
          $let: {
            vars: { i: { $indexOfArray: [{ $literal: refs }, '$driver'] } },
            in: {
              $cond: [{ $gte: ['$$i', 0] }, { $arrayElemAt: [{ $literal: fees }, '$$i'] }, 0],
            },
          },
        },
      },
    },
    { $addFields: { price: { $cond: [{ $gt: ['$service', 0] }, '$service', '$cityFee'] } } },
    {
      $addFields: {
        change: {
          $cond: [
            { $gt: ['$price', 0] },
            {
              $multiply: [
                -1,
                { $round: [{ $multiply: [{ $divide: ['$charge', '$price'] }, 100] }, 0] },
              ],
            },
            0,
          ],
        },
        counted: { $and: [{ $gte: ['$status', 3] }, { $not: ['$canceled'] }] },
      },
    },
  ];
}

/** The orders of these windows that count: each driver's, from their start, delivered. */
function countedMatch(windows: readonly WalletWindow[]): Document {
  return {
    $match: {
      $or: windows.map((w) => ({
        _p_driver: driverRef(w.driverId),
        _created_at: { $gte: w.startsAt },
      })),
      status: { $gte: 3 },
      canceled: { $ne: true },
    },
  };
}

function toRow(doc: Document): OrderUnitRow {
  return {
    orderId: doc._id as string,
    driverId: driverIdOf(doc.driver),
    at: doc.at as Date,
    // `$multiply` by −1 turns 0 into −0.
    change: Number(doc.change) || 0,
    price: Number(doc.price) || 0,
    freeDelivery: doc.freeDelivery === true,
    counted: doc.counted === true,
    status: doc.status,
    canceled: doc.canceled === true,
    money: {
      service: Number(doc.service) || 0,
      delivery: Number(doc.delivery) || 0,
      freeDelivery: doc.freeDelivery === true,
      paymentMethod: doc.paymentMethod,
    },
  };
}

export class MongoDriverWallets implements DriverWallets {
  constructor(
    private readonly walletDocs: Collection<DriverWalletDoc>,
    private readonly entryDocs: Collection<WalletEntryDoc>,
    private readonly orders: Collection<Document>,
    readonly now: () => Date,
  ) {}

  wallet(driverId: string): Promise<DriverWalletDoc | null> {
    return this.walletDocs.findOne({ _id: driverId });
  }

  wallets(driverIds?: readonly string[]): Promise<DriverWalletDoc[]> {
    const filter = driverIds ? { _id: { $in: [...driverIds] } } : {};
    return this.walletDocs.find(filter).toArray();
  }

  /** Creates the wallet from `startsAt`, or opens a closed one again (keeping its start). */
  async open(driverId: string, startsAt: Date, by: WalletActor): Promise<DriverWalletDoc> {
    const update = {
      $setOnInsert: {
        startsAt,
        createdAt: this.now(),
        createdBy: by,
        alert: 'ok' as const,
        alertAt: null,
      },
      $set: { closedAt: null },
    };
    try {
      return (await this.walletDocs.findOneAndUpdate({ _id: driverId }, update, {
        upsert: true,
        returnDocument: 'after',
      }))!;
    } catch (error) {
      // Two first top-ups racing on one driver: the loser's upsert hits `_id`; the wallet exists.
      if ((error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
      return (await this.walletDocs.findOneAndUpdate(
        { _id: driverId },
        { $set: { closedAt: null } },
        {
          returnDocument: 'after',
        },
      ))!;
    }
  }

  async close(driverId: string): Promise<void> {
    await this.walletDocs.updateOne({ _id: driverId }, { $set: { closedAt: this.now() } });
  }

  async setAlert(driverId: string, level: WalletLevel): Promise<void> {
    await this.walletDocs.updateOne(
      { _id: driverId, alert: { $ne: level } },
      { $set: { alert: level, alertAt: this.now() } },
    );
  }

  /** Moves the alert to `level`; true for exactly one caller, the one that gets to push. */
  async claimAlert(driverId: string, level: WalletLevel): Promise<boolean> {
    const { modifiedCount } = await this.walletDocs.updateOne(
      { _id: driverId, alert: { $ne: level } },
      { $set: { alert: level, alertAt: this.now() } },
    );
    return modifiedCount === 1;
  }

  /**
   * Records the entry under its request id. A retry of the same request finds the first one and
   * says so (`created: false`) instead of recording it twice.
   */
  async addEntry(entry: NewWalletEntry): Promise<{ entry: WalletEntryDoc; created: boolean }> {
    const doc: WalletEntryDoc = { ...entry, at: this.now(), voided: null };
    try {
      await this.entryDocs.insertOne(doc);
      return { entry: doc, created: true };
    } catch (error) {
      if ((error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
      return { entry: (await this.entryDocs.findOne({ _id: entry._id }))!, created: false };
    }
  }

  entry(entryId: string): Promise<WalletEntryDoc | null> {
    return this.entryDocs.findOne({ _id: entryId });
  }

  entries(driverIds: readonly string[]): Promise<WalletEntryDoc[]> {
    return this.entryDocs
      .find({ driverId: { $in: [...driverIds] } })
      .sort({ at: -1 })
      .toArray();
  }

  /** Voids an entry that isn't voided yet; false when it already was (or doesn't exist). */
  async voidEntry(entryId: string, by: WalletActor, reason: string): Promise<boolean> {
    const { modifiedCount } = await this.entryDocs.updateOne(
      { _id: entryId, voided: null },
      { $set: { voided: { at: this.now(), by, reason } } },
    );
    return modifiedCount === 1;
  }

  /** Every counted order of these windows, newest first; `credits` keeps only those that add. */
  async orderRows(
    windows: readonly WalletWindow[],
    opts: { credits?: boolean } = {},
  ): Promise<OrderUnitRow[]> {
    if (windows.length === 0) return [];
    const pipeline: Document[] = [countedMatch(windows), ...unitStages(windows)];
    if (opts.credits) pipeline.push({ $match: { change: { $gt: 0 } } });
    pipeline.push({ $sort: { at: -1, _id: -1 } });
    return (await this.orders.aggregate(pipeline).toArray()).map(toRow);
  }

  /** Per driver, what their counted orders add up to (hundredths). */
  async orderTotals(windows: readonly WalletWindow[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (windows.length === 0) return totals;
    const docs = await this.orders
      .aggregate([
        countedMatch(windows),
        ...unitStages(windows),
        { $group: { _id: '$driver', change: { $sum: '$change' } } },
      ])
      .toArray();
    for (const doc of docs) {
      const driverId = driverIdOf(doc._id);
      if (driverId) totals.set(driverId, Number(doc.change) || 0);
    }
    return totals;
  }

  /**
   * One order as a wallet would see it, whatever its state (null when it doesn't exist): read
   * before and after a staff edit, to tell finance what the edit gave back or took.
   */
  async probeOrder(
    orderId: string,
    windows: readonly WalletWindow[],
  ): Promise<OrderUnitRow | null> {
    const [doc] = await this.orders
      .aggregate([{ $match: { _id: orderId } }, ...unitStages(windows)])
      .toArray();
    return doc ? toRow(doc) : null;
  }
}
