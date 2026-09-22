// Port of legacy cloud/order/manager.js.
import { languageOf, messagesFor, withOrder } from '../../domain/i18n.js';
import { detach, type FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireUser } from '../guards.js';
import { notifyStaff, sendPush } from '../notify.js';
import { CLASSES } from '../pointers.js';

export const orderManagerFunctions: FunctionTable = {
  async cancelManager(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId, reason, fromAdmin, noNotifs } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    query.include('driver');
    query.include('restaurant');
    const order = (await query.first({ useMasterKey: true }))!;
    if (order.get('status') > 1) throw CLOUD_ERRORS.ORDER_FULLFILLED;
    order.set('canceled', true);
    await order.save(null, { useMasterKey: true });
    const user = order.get('user');
    const driver = order.get('driver');
    const restaurant = order.get('restaurant');
    const pushToken = user.get('pushToken');
    const cancelData = { id: objectId, cancel: 'true', icon: 'error' };
    if (!noNotifs && pushToken && pushToken.food) {
      const m = messagesFor(languageOf(user));
      const title = withOrder(m.canceledFromManager, objectId) + ' ' + restaurant.get('name');
      const body = reason ? m.reason + ': ' + reason : undefined;
      sendPush(deps, { title, body, token: pushToken.food, data: cancelData });
    }
    if (
      !noNotifs &&
      reason &&
      driver &&
      driver.get('pushToken') &&
      driver.get('pushToken').driver
    ) {
      const m = messagesFor(languageOf(driver));
      const title = withOrder(m.canceledFromManager, objectId) + ' ' + restaurant.get('name');
      const body = m.reason + ': ' + reason;
      sendPush(deps, { title, body, token: driver.get('pushToken').driver, data: cancelData });
    }
    const config = await Parse.Config.get();
    if (!fromAdmin && (reason || config.get('sendManagerNotifs'))) {
      if (user.get('city')) {
        await notifyStaff(deps, {
          city: user.get('city'),
          objectId,
          page: 'orders',
          title: (m) => withOrder(m.canceledFromManager, objectId) + ' ' + restaurant.get('name'),
        });
      }
    }
    return 1;
  },

  async acceptManager(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId, noChoose } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    query.include('restaurant');
    const order = await query.first({ useMasterKey: true });
    if (!order || order.get('canceled')) throw CLOUD_ERRORS.ORDER_CANCELED;
    if (order.get('status') > 0) throw CLOUD_ERRORS.ORDER_FULLFILLED;
    order.set('status', 1);
    await order.save(null, { useMasterKey: true });
    const query2 = new Parse.Query(CLASSES.store);
    query2.equalTo('objectId', order.get('restaurant').id);
    const store = (await query2.first({ useMasterKey: true }))!;
    store.set('ordersAccepted', store.get('ordersAccepted') + 1);
    await store.save(null, { useMasterKey: true });
    const user = order.get('user');
    const restaurant = order.get('restaurant');
    const pushToken = user.get('pushToken');
    if (pushToken && pushToken.food) {
      const m = messagesFor(languageOf(user));
      const title = withOrder(m.confirmed, objectId) + ' ' + restaurant.get('name');
      sendPush(deps, {
        title,
        token: pushToken.food,
        data: { id: objectId, icon: 'success', button: m.viewOrder, screen: 'OrderDetails' },
      });
    }
    // The manager app never sends noChoose, so accepting a delivery starts automatic dispatch (OD-2).
    if (order.get('deliveryType') === 'delivery' && !noChoose) {
      detach(deps, 'chooseDriver', deps.dispatch.start({ objectId }));
    }
    return 1;
  },

  async finishManager(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    query.include('user');
    const order = await query.first({ useMasterKey: true });
    if (!order || order.get('canceled')) throw CLOUD_ERRORS.ORDER_CANCELED;
    order.set('isReady', true);
    if (order.get('deliveryType') === 'pickup') {
      order.set('status', 2);
      await order.save(null, { useMasterKey: true });
      const user = order.get('user');
      const pushToken = user.get('pushToken');
      if (pushToken && pushToken.food) {
        const m = messagesFor(languageOf(user));
        const title = withOrder(m.prepared, objectId);
        sendPush(deps, {
          title,
          token: pushToken.food,
          data: { id: objectId, icon: 'prepared', button: m.viewOrder, screen: 'OrderDetails' },
        });
      }
    } else {
      await order.save(null, { useMasterKey: true });
    }
    return 1;
  },

  async confirmManager(req, deps) {
    const { Parse } = deps;
    requireUser(req);
    const { objectId } = req.params as Record<string, unknown>;
    if (!objectId) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', objectId);
    const order = await query.first({ useMasterKey: true });
    if (!order || order.get('canceled')) throw CLOUD_ERRORS.ORDER_CANCELED;
    if (order.get('deliveryType') === 'pickup') {
      order.set('status', 3);
      await order.save(null, { useMasterKey: true });
    }
    return 1;
  },
};
