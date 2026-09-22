// Port of legacy cloud/order/driver.js (functions). The dispatch job is in src/jobs.
import { languageOf, messagesFor, withOrder } from '../../domain/i18n.js';
import { detach, type FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireUser } from '../guards.js';
import { notifyStaff, sendPush } from '../notify.js';
import { notifyOpsDriverDeclined } from '../ops-channels.js';
import { CLASSES } from '../pointers.js';

export const orderDriverFunctions: FunctionTable = {
  // Returns nothing (the response body is `{}`), unlike the other order functions.
  async cancelDriver(req, deps) {
    const user = requireUser(req);
    const { objectId, reason } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    // Only the driver holding the order hands it back (D-20). Anyone else, like a driver ops took
    // off it whose push never came, is off it already: no write, no staff push, no dispatch.
    if (!(await deps.claims.release(objectId, user.id!))) return undefined;
    if (reason) {
      if (user.get('city')) {
        await notifyStaff(deps, {
          city: user.get('city'),
          objectId,
          page: 'orders',
          title: (m) =>
            withOrder(m.canceledFromDriver, objectId) + ' - ' + m.reason + ': ' + reason,
        });
      }
    } else {
      // Without a reason (incl. ''), dispatch restarts and skips this driver.
      detach(deps, 'chooseDriver', deps.dispatch.start({ objectId, driverId: user.id }));
    }
    return undefined;
  },

  async checkDriver(req, deps) {
    const { Parse } = deps;
    const user = requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    const order = await query.first({ useMasterKey: true });
    if (!order || order.get('canceled')) throw CLOUD_ERRORS.ORDER_CANCELED;
    if (order.get('driver') && order.get('driver').id === user.id) {
      const query2 = new Parse.Query(Parse.User);
      query2.equalTo('objectId', user.id);
      const driver = (await query2.first({ useMasterKey: true }))!;
      driver.set('driverOrdersAccepted', driver.get('driverOrdersAccepted') + 1);
      await driver.save(null, { useMasterKey: true });
      return 1;
    }
    throw CLOUD_ERRORS.ORDER_FULLFILLED;
  },

  async acceptDriver(req, deps) {
    const user = requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    // One atomic write decides between drivers accepting at the same moment (D-20).
    const outcome = await deps.claims.claim(objectId, user.id!);
    if (outcome === 'canceled') throw CLOUD_ERRORS.ORDER_CANCELED;
    if (outcome === 'taken') throw CLOUD_ERRORS.ORDER_FULLFILLED;
    await deps.dispatch.cancel(objectId);
    // Taken, so the offer is over: if it is ever handed back, every driver may be sent it again (D-21).
    detach(deps, 'clear driver offers', deps.offers.clear(objectId));
    return 1;
  },

  /**
   * Not in legacy (D-23). A driver turning down an order they were sent, before anyone took it:
   * stored under `driverDeclines.<driverId>` on the order (the next `assignDriver` to that driver
   * forgets it) and announced to ops over Pusher, which only refresh on it. Answers `{}`
   * whatever happened, like `cancelDriver`: the app hides the card either way and never waits.
   */
  async declineDriver(req, deps) {
    const { Parse } = deps;
    const user = requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId || typeof objectId !== 'string') throw CLOUD_ERRORS.MISSING_PARAMS;
    const log = deps.logger.child({ fn: 'declineDriver', orderId: objectId, driverId: user.id });
    // Only a driver the order was sent to may turn it down, so nobody else can raise it with ops.
    if (!(await deps.offers.wasOffered(objectId, user.id!))) {
      log.warn('declineDriver ignored: order was never sent to this driver');
      return undefined;
    }
    const driver = await new Parse.Query(Parse.User)
      .equalTo('objectId', user.id)
      .first({ useMasterKey: true });
    const driverName = (driver?.get('fullname') as string | undefined) ?? null;
    const decline = await deps.declines.record(objectId, user.id!, driverName);
    if (!decline) {
      log.info('declineDriver ignored: order canceled, gone or already taken');
      return undefined;
    }
    const order = await new Parse.Query(CLASSES.order)
      .equalTo('objectId', objectId)
      .first({ useMasterKey: true });
    const cityId: string | null = order?.get('city')?.id ?? null;
    log.info({ cityId }, 'declineDriver: stored, notifying ops');
    notifyOpsDriverDeclined(deps, {
      orderId: objectId,
      driverId: user.id!,
      driverName,
      cityId,
      declinedAt: decline.at,
    });
    return undefined;
  },

  async toDestinationDriver(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    query.include('driver');
    const order = (await query.first({ useMasterKey: true }))!;
    order.set('status', 2);
    await order.save(null, { useMasterKey: true });
    const user = order.get('user');
    const pushToken = user.get('pushToken');
    if (pushToken && pushToken.food) {
      const m = messagesFor(languageOf(user));
      const title = withOrder(m.onTheWay, objectId);
      sendPush(deps, {
        title,
        token: pushToken.food,
        data: {
          id: objectId,
          icon: 'onTheWay',
          button: m.trackOrder,
          screen: 'TrackOrder',
          driverId: order.get('driver').id,
        },
      });
    }
    return 1;
  },

  async arrivedDriver(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    const order = (await query.first({ useMasterKey: true }))!;
    const user = order.get('user');
    const pushToken = user.get('pushToken');
    if (pushToken && pushToken.food) {
      const m = messagesFor(languageOf(user));
      const title = withOrder(m.arrived, objectId);
      sendPush(deps, {
        title,
        token: pushToken.food,
        data: { id: objectId, icon: 'arrived', button: m.viewOrder, screen: 'OrderDetails' },
      });
    }
    return 1;
  },

  async finishDriver(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    query.include('driver');
    const order = (await query.first({ useMasterKey: true }))!;
    order.set('status', 3);
    await order.save(null, { useMasterKey: true });
    const user = order.get('user');
    const pushToken = user.get('pushToken');
    if (pushToken && pushToken.food) {
      // Data-only push: the app opens the rating screen.
      sendPush(deps, {
        token: pushToken.food,
        data: {
          rate: 'true',
          orderId: objectId,
          id: order.get('driver').id,
          restaurantId: order.get('restaurant').id,
        },
      });
    }
    return 1;
  },
};
