import type { Collection } from 'mongodb';
import type { DriverOffers } from './context.js';

/** A plain MongoDB collection next to `agendaJobs`: not a Parse class, so no client ever sees it. */
export const DRIVER_OFFERS_COLLECTION = 'driverOffers';

/** One row per driver an order was sent to during its current offer. */
export interface DriverOfferDoc {
  /** `<orderId>:<driverId>`, so the unique `_id` index is what makes a second record fail. */
  _id: string;
  orderId: string;
  driverId: string;
  offeredAt: Date;
}

const DUPLICATE_KEY = 11000;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first record of a pair is an upsert that inserts; any later one, or one racing it, matches or
 * hits the `_id` index instead, so exactly one caller learns it was first. Clearing is an anchored
 * `_id` prefix match, which that same index serves: no other index is needed.
 */
export class MongoDriverOffers implements DriverOffers {
  constructor(
    private readonly offers: Collection<DriverOfferDoc>,
    private readonly now: () => Date,
  ) {}

  async markOffered(orderId: string, driverId: string): Promise<boolean> {
    try {
      const { upsertedCount } = await this.offers.updateOne(
        { _id: `${orderId}:${driverId}` },
        { $setOnInsert: { orderId, driverId, offeredAt: this.now() } },
        { upsert: true },
      );
      return upsertedCount === 1;
    } catch (error) {
      // Two upserts inserting the same new _id: the server retries the loser, but not always.
      if ((error as { code?: unknown }).code === DUPLICATE_KEY) return false;
      throw error;
    }
  }

  async wasOffered(orderId: string, driverId: string): Promise<boolean> {
    return (await this.offers.countDocuments({ _id: `${orderId}:${driverId}` }, { limit: 1 })) > 0;
  }

  async clear(orderId: unknown): Promise<void> {
    if (typeof orderId !== 'string') return;
    await this.offers.deleteMany({ _id: { $regex: `^${escapeRegex(orderId)}:` } });
  }
}
