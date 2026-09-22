// Port of legacy cloud/agenda.js (the `chooseDriver` job) and `chooseDriver()` from
// cloud/order/driver.js. Automatic dispatch is live legacy behaviour (inventory §4, OD-2).
import type { ObjectId } from 'mongodb';
import { languageOf, messagesFor, withOrder } from '../domain/i18n.js';
import { type CloudDeps, detach, type DispatchScheduler } from '../cloud/context.js';
import { CLOUD_ERRORS } from '../cloud/errors.js';
import { notifyDriverNewOrder, notifyStaff, recordOffer, sendPush } from '../cloud/notify.js';
import { CLASSES } from '../cloud/pointers.js';
import type { JobDoc, LegacyAgendaStore } from './legacy-agenda-store.js';

export const JOB_NAME = 'chooseDriver';
const DISTANCE_INCREMENT_KM = 1;
const CANCEL_DISTANCE_KM = 6;
const CHOOSE_INTERVAL_MS = 2 * 60 * 1000;

export interface ChooseDriverData {
  objectId: unknown;
  iteration: number;
  calledDriver?: unknown;
  lastRun?: unknown;
}

export interface DispatchContext {
  deps: CloudDeps;
  store: LegacyAgendaStore;
  now: () => Date;
}

/**
 * One dispatch round. Search radius 1 + iteration km, widened until drivers are found or it
 * reaches 6 km; every driver found who wasn't sent the order yet this offer is notified (D-21), and
 * the next round is scheduled in 2 minutes (one extra empty round via `lastRun`). When exhausted:
 * cancel the order (unless Config `noDriverHandleAdmin`) and tell the customer, the manager and
 * staff.
 */
export async function runChooseDriver(
  ctx: DispatchContext,
  jobId: ObjectId,
  data: ChooseDriverData,
): Promise<void> {
  const { deps } = ctx;
  const { Parse } = deps;
  const { objectId, iteration, calledDriver, lastRun } = data;
  let usedIteration = iteration;
  let usedDistance = DISTANCE_INCREMENT_KM + usedIteration * DISTANCE_INCREMENT_KM;
  await ctx.store.cancel({ _id: jobId });

  const query = new Parse.Query(CLASSES.order);
  query.equalTo('objectId', objectId);
  query.include('user');
  query.include('restaurant');
  const order = await query.first({ useMasterKey: true });
  if (!order || order.get('driver') || order.get('canceled')) return;

  const config = await Parse.Config.get();
  if (usedDistance < CANCEL_DISTANCE_KM) {
    const driverRealtime = config.get('driverRealtime');
    let drivers: InstanceType<typeof Parse.User>[];
    do {
      const query2 = new Parse.Query(Parse.User);
      query2.equalTo('appType', 'driver');
      query2.equalTo('enabled', true);
      query2.equalTo('driverActive', true);
      query2.withinKilometers(
        'driverLocation',
        order.get('restaurant').get('location'),
        usedDistance,
        true,
      );
      query2.descending('driverRating');
      if (calledDriver) query2.notEqualTo('objectId', calledDriver);
      drivers = await query2.find({ useMasterKey: true });
      usedIteration += 1;
      usedDistance = DISTANCE_INCREMENT_KM + usedIteration * DISTANCE_INCREMENT_KM;
    } while (drivers.length === 0 && usedDistance < CANCEL_DISTANCE_KM);

    // Each driver gets the order from the search once per offer (D-21). Rounds still widen and
    // reach new drivers, but never send it again to one the search or ops already sent it to.
    const firsts = await Promise.all(drivers.map((d) => recordOffer(deps, order.id!, d.id!)));
    drivers.forEach((driver, i) => {
      if (firsts[i]) notifyDriverNewOrder(deps, driver, objectId, driverRealtime, 'chooseDriver');
    });

    let usedLastRun = false;
    if (drivers.length === 0 && !lastRun) {
      usedIteration -= 1;
      usedLastRun = true;
    }
    if (drivers.length > 0 || usedLastRun) {
      await ctx.store.schedule(
        JOB_NAME,
        // calledDriver is `undefined` in legacy, which the driver stores as null.
        {
          objectId,
          iteration: usedIteration,
          calledDriver: calledDriver ?? null,
          lastRun: usedLastRun,
        },
        new Date(ctx.now().getTime() + CHOOSE_INTERVAL_MS),
      );
      return;
    }
  }

  // No driver found. The search gave up, which ends the offer: a later one may reach them all again.
  detach(deps, 'clear driver offers', deps.offers.clear(order.id));
  const handleAdmin = config.get('noDriverHandleAdmin');
  if (!handleAdmin) {
    const query2 = new Parse.Query(CLASSES.store);
    query2.equalTo('objectId', order.get('restaurant').id);
    query2.include('manager');
    const store = (await query2.first({ useMasterKey: true }))!;
    const manager = store.get('manager');
    const user = order.get('user');
    // A driver may have accepted since this round read the order: cancel it only while it has
    // none, and then tell nobody (D-20).
    if (!(await deps.claims.cancelUnclaimed(order.id!))) return;
    const data = { id: objectId, cancel: 'true', icon: 'error' };
    if (user.get('pushToken') && user.get('pushToken').food) {
      const title = withOrder(messagesFor(languageOf(user)).canceledNoDriver, objectId);
      sendPush(deps, { title, token: user.get('pushToken').food, data });
    }
    if (
      manager &&
      manager.get('enabled') &&
      manager.get('pushToken') &&
      manager.get('pushToken').manager
    ) {
      const title = withOrder(messagesFor(languageOf(manager)).canceledNoDriver, objectId);
      sendPush(deps, { title, token: manager.get('pushToken').manager, data });
    }
  }
  if (order.get('user').get('city')) {
    await notifyStaff(deps, {
      city: order.get('user').get('city'),
      objectId,
      page: 'orders',
      config,
      title: (m) =>
        handleAdmin
          ? withOrder(m.noDriverActionRequired, objectId)
          : withOrder((m.canceledNoDriver as string).split(',')[0], objectId),
    });
  }
}

/** `chooseDriver({ objectId, driverId })` and `agenda.cancel` for the cloud functions. */
export function createDispatchScheduler(ctx: DispatchContext): DispatchScheduler {
  return {
    async start({ objectId, driverId }) {
      if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
      const data: ChooseDriverData = { objectId, iteration: 0, calledDriver: driverId ?? null };
      // agenda.create + unique({ 'data.objectId' }) + job.run(): the first save upserts the row
      // with no next run, then the first round runs in this process.
      const id = await ctx.store.upsertRunning(
        JOB_NAME,
        { ...data },
        { 'data.objectId': objectId },
        ctx.now(),
      );
      await runChooseDriver(ctx, id, data);
    },
    async cancel(objectId) {
      await ctx.store.cancel({ 'data.objectId': objectId });
    },
  };
}

/**
 * The polling worker (Agenda 4 defaults: every 5 s, lock lifetime 10 min, 5 concurrent jobs).
 * Every instance runs one, like legacy, unless DISPATCH_WORKER_ENABLED=false (canary step 1).
 */
export class DispatchWorker {
  private timer: NodeJS.Timeout | undefined;
  private readonly locked = new Map<string, JobDoc>();
  private readonly pending = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private scanning = false;
  private stopped = false;

  constructor(
    private readonly ctx: DispatchContext,
    private readonly opts: { processEveryMs: number; concurrency?: number },
  ) {}

  start(): void {
    this.stopped = false;
    const tick = () => {
      this.scan().catch((error: unknown) =>
        this.ctx.deps.logger.error({ err: error }, 'dispatch scan failed'),
      );
    };
    tick();
    this.timer = setInterval(tick, this.opts.processEveryMs);
  }

  /** One scan: lock due jobs (up to the concurrency limit) and run each at its nextRunAt. */
  async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const concurrency = this.opts.concurrency ?? 5;
      while (!this.stopped && this.locked.size < concurrency) {
        const now = this.ctx.now();
        const nextScanAt = new Date(now.getTime() + this.opts.processEveryMs);
        const job = await this.ctx.store.findAndLockNext(JOB_NAME, now, nextScanAt);
        if (!job) break;
        this.locked.set(job._id.toHexString(), job);
        const delay = Math.max(0, (job.nextRunAt ? job.nextRunAt.getTime() : 0) - now.getTime());
        const handle = setTimeout(() => {
          this.pending.delete(handle);
          const run = this.runLocked(job).catch((error: unknown) =>
            this.ctx.deps.logger.error({ err: error }, 'dispatch job failed'),
          );
          this.running.add(run);
          void run.finally(() => this.running.delete(run));
        }, delay);
        this.pending.add(handle);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async runLocked(job: JobDoc): Promise<void> {
    try {
      await this.ctx.store.markRunning(job._id, this.ctx.now());
      await runChooseDriver(this.ctx, job._id, job.data as unknown as ChooseDriverData);
    } finally {
      this.locked.delete(job._id.toHexString());
    }
  }

  /**
   * Graceful shutdown: stop polling, drop timers for jobs not started yet, let running rounds
   * finish, then unlock what is left.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const handle of this.pending) clearTimeout(handle);
    this.pending.clear();
    await Promise.all(this.running);
    await this.ctx.store.unlock([...this.locked.values()].map((j) => j._id));
    this.locked.clear();
  }
}
