import type { Collection } from 'mongodb';
import type { OrderDeclines } from './context.js';

/** One driver's "no", as stored under `Order.driverDeclines.<driverId>`. */
export interface DeclineDoc {
  /** The driver's `fullname`, copied so ops never read the driver's row to say who. */
  name: string | null;
  /** ISO time. */
  at: string;
}

/** The Order fields a decline writes, in Parse's MongoDB storage format (see order-claims.ts). */
export interface OrderDeclineDoc {
  _id: string;
  _p_driver?: string | null;
  canceled?: boolean;
  driverDeclines?: Record<string, DeclineDoc>;
  _updated_at?: Date;
}

/** Parse objectIds. Anything else could not be a key in the `driverDeclines` object. */
const OBJECT_ID = /^[A-Za-z0-9]{1,32}$/;

/**
 * `Order.driverDeclines` (D-23): an Object keyed by driver id, so every driver who declines is
 * one `$set` of their own key. Fifty drivers declining at once are fifty writes that can't lose
 * each other, where a read-modify-write of an array would. Written in Parse's storage format
 * directly, like the claims next door (ADR 0002): `Order` has no triggers and LiveQuery is off.
 */
export class MongoOrderDeclines implements OrderDeclines {
  constructor(
    private readonly orders: Collection<OrderDeclineDoc>,
    private readonly now: () => Date,
  ) {}

  async record(orderId: string, driverId: string, name: string | null): Promise<DeclineDoc | null> {
    if (!OBJECT_ID.test(orderId) || !OBJECT_ID.test(driverId)) return null;
    const decline: DeclineDoc = { name, at: this.now().toISOString() };
    // Only while the order is still open: a decline of one somebody took, or that was
    // canceled, says nothing ops can use.
    const { matchedCount } = await this.orders.updateOne(
      { _id: orderId, canceled: { $ne: true }, _p_driver: null },
      { $set: { [`driverDeclines.${driverId}`]: decline, _updated_at: this.now() } },
    );
    return matchedCount === 1 ? decline : null;
  }

  async clear(orderId: string, driverId: string): Promise<void> {
    if (!OBJECT_ID.test(orderId) || !OBJECT_ID.test(driverId)) return;
    await this.orders.updateOne(
      { _id: orderId, [`driverDeclines.${driverId}`]: { $exists: true } },
      { $unset: { [`driverDeclines.${driverId}`]: '' }, $set: { _updated_at: this.now() } },
    );
  }
}
