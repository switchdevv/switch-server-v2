import type { Collection } from 'mongodb';
import type { ClaimOutcome, OrderClaims } from './context.js';

/**
 * The Order fields a claim reads and writes, in Parse's MongoDB storage format: `_id` is the
 * objectId, the `driver` pointer is `_p_driver: '_User$<id>'`, and Parse clears it by writing
 * `null`, which reads back as no driver.
 */
export interface OrderDoc {
  _id: string;
  _p_driver?: string | null;
  canceled?: boolean;
  _updated_at?: Date;
}

const driverRef = (driverId: string) => `_User$${driverId}`;

/**
 * Parse has no conditional save, so each change here is one `updateOne` whose filter holds the
 * precondition: MongoDB matches and writes a document atomically, so of two racing writers
 * exactly one matches. `Order` has no triggers and LiveQuery is off, so writing its storage format
 * directly skips nothing Parse would do (ADR 0002). Relies on prod's `Order.driver` column.
 */
export class MongoOrderClaims implements OrderClaims {
  constructor(
    private readonly orders: Collection<OrderDoc>,
    private readonly now: () => Date,
  ) {}

  async claim(orderId: unknown, driverId: string): Promise<ClaimOutcome> {
    if (typeof orderId !== 'string') return 'canceled';
    const ref = driverRef(driverId);
    const { matchedCount } = await this.orders.updateOne(
      { _id: orderId, canceled: { $ne: true }, _p_driver: { $in: [null, ref] } },
      { $set: { _p_driver: ref, _updated_at: this.now() } },
    );
    if (matchedCount === 1) return 'claimed';
    // Lost: this read only names the reason, with legacy's precedence (canceled first).
    const order = await this.orders.findOne({ _id: orderId }, { projection: { canceled: 1 } });
    return !order || order.canceled === true ? 'canceled' : 'taken';
  }

  async release(orderId: unknown, driverId: string): Promise<boolean> {
    if (typeof orderId !== 'string') return false;
    const { matchedCount } = await this.orders.updateOne(
      { _id: orderId, _p_driver: driverRef(driverId) },
      { $set: { _p_driver: null, _updated_at: this.now() } },
    );
    return matchedCount === 1;
  }

  async cancelUnclaimed(orderId: string): Promise<boolean> {
    const { matchedCount } = await this.orders.updateOne(
      { _id: orderId, _p_driver: null },
      { $set: { canceled: true, _updated_at: this.now() } },
    );
    return matchedCount === 1;
  }
}
