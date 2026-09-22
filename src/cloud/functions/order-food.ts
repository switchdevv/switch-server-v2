// Port of legacy cloud/order/food.js.
import {
  deliveryFee,
  distanceFromText,
  type FeeTable,
  type TripDuration,
  tripMinutes,
} from '../../domain/fees.js';
import { languageOf, messagesFor, withOrder } from '../../domain/i18n.js';
import type { FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireUser } from '../guards.js';
import { notifyStaff, sendPush } from '../notify.js';
import { CLASSES, pointer } from '../pointers.js';

interface LatLng {
  latitude: unknown;
  longitude: unknown;
}

export const orderFoodFunctions: FunctionTable = {
  async calculateOrder(req, deps) {
    requireUser(req);
    const { from, to, city, appType } = req.params as Record<string, unknown>;
    if (!from || !to || !city || !appType) throw CLOUD_ERRORS.MISSING_PARAMS;
    const origin = (from as LatLng).latitude + ',' + (from as LatLng).longitude;
    const destination = (to as LatLng).latitude + ',' + (to as LatLng).longitude;
    const distances = (await deps.ports.distance.matrix(origin, destination)) as {
      status?: unknown;
      rows: { elements: { status?: unknown; distance: { text: unknown } }[] }[];
    } | null;
    if (
      !distances ||
      distances.status !== 'OK' ||
      distances.rows[0]!.elements[0]!.status !== 'OK'
    ) {
      throw CLOUD_ERRORS.DISTANCE_ERROR;
    }
    const distance = distanceFromText(distances.rows[0]!.elements[0]!.distance.text);
    const config = await deps.Parse.Config.get();
    const duration = tripMinutes(distance, config.get('tripDuration') as TripDuration);
    // `city` is the client's own copy of the City row; fees are read from it, not from the DB.
    const fees = (city as { fees: Record<string, FeeTable> }).fees[appType as string] as FeeTable;
    const delivery = deliveryFee(distance, fees);
    return { distance, duration, delivery };
  },

  // Q-3: no ownership check.
  async cancelFood(req, deps) {
    const { Parse } = deps;
    const user = requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    const order = (await query.first({ useMasterKey: true }))!;
    if (order.get('status') > 0) throw CLOUD_ERRORS.USER_UNAUTHORIZED;
    order.set('canceled', true);
    await order.save(null, { useMasterKey: true });
    const query2 = new Parse.Query(CLASSES.store);
    query2.equalTo('objectId', order.get('restaurant').id);
    query2.include('manager');
    const store = (await query2.first({ useMasterKey: true }))!;
    const manager = store.get('manager');
    const pushToken = manager ? manager.get('pushToken') : null;
    const managerNotified = store.get('enabled') && pushToken && pushToken.manager;
    if (managerNotified) {
      const title = withOrder(messagesFor(languageOf(manager)).canceledTo, objectId);
      sendPush(deps, {
        title,
        token: pushToken.manager,
        data: { id: objectId, cancel: 'true', icon: 'error' },
      });
    }
    const config = await Parse.Config.get();
    if (config.get('sendManagerNotifs') || !managerNotified) {
      if (user.get('city')) {
        await notifyStaff(deps, {
          city: user.get('city'),
          objectId,
          page: 'orders',
          title: (m) => withOrder(m.canceledTo, objectId),
        });
      }
    }
    return 1;
  },

  async orderRated(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    const order = (await query.first({ useMasterKey: true }))!;
    order.set('driverRated', true);
    await order.save(null, { useMasterKey: true });
    return 1;
  },

  async placeOrder(req, deps) {
    const { Parse } = deps;
    const user = requireUser(req);
    const params = req.params as Record<string, unknown>;
    const {
      userId,
      restaurantId,
      userAddressId,
      foodIds,
      promoId,
      deliveryType,
      type,
      options,
      distance,
      duration,
      cardPayment,
    } = params;
    if (
      !userId ||
      !restaurantId ||
      !userAddressId ||
      !foodIds ||
      !deliveryType ||
      !type ||
      !options ||
      distance === undefined ||
      duration === undefined
    ) {
      throw CLOUD_ERRORS.MISSING_PARAMS;
    }
    // Card payments are off (D-12). Legacy tried a Stripe charge here, before any write, and turned
    // every failure (always, with its blank key) into FAILED_TO_PROCESS_PAYMENT.
    if (cardPayment) throw CLOUD_ERRORS.FAILED_TO_PROCESS_PAYMENT;
    const query = new Parse.Query(CLASSES.store);
    query.equalTo('objectId', restaurantId);
    query.include('manager');
    const store = (await query.first({ useMasterKey: true }))!;
    if (!store.get('enabled')) throw CLOUD_ERRORS.STORE_DISABLED;

    const food = (foodIds as unknown[]).map((id) => pointer(Parse, CLASSES.product, id));
    const order = new Parse.Object(CLASSES.order);
    const fields: Record<string, unknown> = {
      user: pointer(Parse, '_User', userId),
      restaurant: pointer(Parse, CLASSES.store, restaurantId),
      userAddress: pointer(Parse, CLASSES.address, userAddressId),
      food,
      deliveryType,
      type,
      options,
      distance,
      duration,
      status: 0,
      isReady: false,
      canceled: false,
      driverRated: false,
      city: store.get('city'),
    };
    for (const [key, value] of Object.entries(fields)) order.set(key, value);
    if (promoId) order.set('promo', pointer(Parse, CLASSES.promo, promoId));
    await order.save(null, { useMasterKey: true });

    // Q-10: read-modify-write counter.
    store.set('ordersTotal', store.get('ordersTotal') + 1);
    await store.save(null, { useMasterKey: true });

    const objectId = order.id;
    const manager = store.get('manager');
    const pushToken = manager ? manager.get('pushToken') : null;
    if (pushToken && pushToken.manager) {
      const title = messagesFor(languageOf(manager)).newOrder + ' #' + objectId;
      sendPush(deps, {
        title,
        token: pushToken.manager,
        data: { id: objectId, newOrder: 'true', launchApp: 'true', playSound: 'true' },
      });
    }
    const config = await Parse.Config.get();
    if (config.get('sendManagerNotifs') || !(pushToken && pushToken.manager)) {
      if (user.get('city')) {
        await notifyStaff(deps, {
          city: user.get('city'),
          objectId,
          page: 'orders',
          title: (m) => m.newOrder + ' #' + objectId,
        });
      }
    }
    return 1;
  },
};
