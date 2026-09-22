import type { Collection, Document, ObjectId } from 'mongodb';

/**
 * The Agenda 4.1.3 job-document protocol, reimplemented on the MongoDB 7 driver (plan §6.6
 * fallback, ADR in docs/adr/0001-dispatch-job-store.md). Legacy and v2 workers share
 * `agendaJobs` during the canary, so every read and write here mirrors what 4.1.3 does:
 *
 * - lock:     findOneAndUpdate({ name, disabled ≠ true, (lockedAt null ∧ nextRunAt ≤ nextScanAt) ∨
 *             lockedAt ≤ now − lockLifetime }, { $set: { lockedAt: now } }, sort { nextRunAt: 1, priority: -1 })
 * - schedule: insertOne({ name, data, type: 'normal', priority: 0, nextRunAt, lastModifiedBy: null })
 * - unique:   findOneAndUpdate({ ...unique, name }, { $set: props }, { upsert: true })
 * - remove / cancel: deleteMany(query)
 *
 * Rows with `nextRunAt: null` and no lock (legacy's orphans) never match the lock query (J-5).
 */
export interface JobDoc extends Document {
  _id: ObjectId;
  name: string;
  data: Record<string, unknown>;
  type?: string;
  priority?: number;
  nextRunAt?: Date | null;
  lockedAt?: Date | null;
  lastRunAt?: Date | null;
  disabled?: boolean;
}

export class LegacyAgendaStore {
  constructor(
    private readonly collection: Collection<JobDoc>,
    private readonly lockLifetimeMs: number,
  ) {}

  /** `agenda.schedule(when, name, data)` → a fresh 'normal' job. */
  async schedule(name: string, data: Record<string, unknown>, nextRunAt: Date): Promise<ObjectId> {
    const result = await this.collection.insertOne({
      name,
      data,
      type: 'normal',
      priority: 0,
      nextRunAt,
      lastModifiedBy: null,
    } as unknown as JobDoc);
    return result.insertedId;
  }

  /**
   * `agenda.create(name, data).unique(query)` followed by `job.run()`'s first save: an upsert that
   * marks the job as running now (`lastRunAt`) with no next run. Returns the row's id.
   */
  async upsertRunning(
    name: string,
    data: Record<string, unknown>,
    unique: Record<string, unknown>,
    now: Date,
  ): Promise<ObjectId> {
    const doc = await this.collection.findOneAndUpdate(
      { ...unique, name },
      {
        $set: {
          name,
          data,
          type: 'normal',
          priority: 0,
          nextRunAt: null,
          lastRunAt: now,
          lastModifiedBy: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return doc!._id;
  }

  /** Worker path of `job.run()`: record the run start on the locked row. */
  async markRunning(id: ObjectId, now: Date): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: { lastRunAt: now, nextRunAt: null } });
  }

  async findAndLockNext(name: string, now: Date, nextScanAt: Date): Promise<JobDoc | null> {
    const lockDeadline = new Date(now.getTime() - this.lockLifetimeMs);
    return this.collection.findOneAndUpdate(
      {
        $and: [
          { name, disabled: { $ne: true } },
          {
            $or: [
              { lockedAt: { $eq: null }, nextRunAt: { $lte: nextScanAt } },
              { lockedAt: { $lte: lockDeadline } },
            ],
          },
        ],
      },
      { $set: { lockedAt: now } },
      { sort: { nextRunAt: 1, priority: -1 }, returnDocument: 'after' },
    );
  }

  /** `agenda.cancel(query)` / `job.remove()`: a raw deleteMany, so partial data matches work. */
  async cancel(query: Record<string, unknown>): Promise<number> {
    const result = await this.collection.deleteMany(query);
    return result.deletedCount;
  }

  /** `agenda.stop()`: release the locks this worker holds (D-15). */
  async unlock(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { lockedAt: null } });
  }
}
