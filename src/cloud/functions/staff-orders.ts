// Port of legacy cloud/dashboard/orders.js and the sendPush function from cloud/push/push.js.
import { detach, type FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireStaff } from '../guards.js';
import { notifyDriverNewOrder, recordOffer, sendPush } from '../notify.js';
import { CLASSES, pointer } from '../pointers.js';

export const staffOrderFunctions: FunctionTable = {
  async deleteOrders(req, deps) {
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new deps.Parse.Query(CLASSES.order);
      query.equalTo('objectId', id);
      const obj = (await query.first({ useMasterKey: true }))!;
      await obj.destroy({ useMasterKey: true });
    }
    return 1;
  },

  async editOrder(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { id, status, canceled, options, foodIds } = req.params as Record<string, unknown>;
    if (!id) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', id);
    const order = await query.first({ useMasterKey: true });
    if (order) {
      if (status !== undefined) order.set('status', status);
      if (canceled !== undefined) order.set('canceled', canceled);
      if (options !== undefined)
        order.set('options', { ...order.get('options'), ...(options as object) });
      if (foodIds !== undefined)
        order.set(
          'food',
          (foodIds as unknown[]).map((foodId) => pointer(Parse, CLASSES.product, foodId)),
        );
      await order.save(null, { useMasterKey: true });
    }
    return 1;
  },

  // Manual dispatch (ops): clears the driver and offers the order to one driver.
  async assignDriver(req, deps) {
    const { Parse } = deps;
    const staff = await requireStaff(req, deps);
    const { orderId, driverId } = req.params as Record<string, unknown>;
    if (!orderId || !driverId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const log = deps.logger.child({ fn: 'assignDriver', orderId, driverId, staffId: staff.id });
    const query = new Parse.Query(Parse.User);
    query.equalTo('objectId', driverId);
    const driver = await query.first({ useMasterKey: true });
    if (!driver || !driver.get('enabled') || !driver.get('driverActive')) {
      const reason = !driver ? 'not found' : !driver.get('enabled') ? 'disabled' : 'offline';
      log.warn({ reason }, 'assignDriver refused: driver disconnected');
      throw CLOUD_ERRORS.DRIVER_DISCONNECTED;
    }
    const query2 = new Parse.Query(CLASSES.order);
    query2.equalTo('objectId', orderId);
    const order = (await query2.first({ useMasterKey: true }))!;
    order.set('canceled', false);
    order.set('driver', null);
    await order.save(null, { useMasterKey: true });
    // Sent to this driver again: their earlier "no" no longer describes the offer (D-23).
    await deps.declines.clear(order.id!, driver.id!);
    const config = await Parse.Config.get();
    // Ops always send, however often (D-21). The record only stops the automatic search from
    // sending this driver the same order again.
    const firstOffer = await recordOffer(deps, order.id!, driver.id!);
    log.info({ firstOffer }, 'assignDriver: order cleared, notifying driver');
    notifyDriverNewOrder(deps, driver, orderId, config.get('driverRealtime'), 'assignDriver');
    return 1;
  },

  async chooseDriver(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { orderId } = req.params as Record<string, unknown>;
    if (!orderId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(CLASSES.order);
    query.equalTo('objectId', orderId);
    const order = (await query.first({ useMasterKey: true }))!;
    order.set('canceled', false);
    order.set('driver', null);
    await order.save(null, { useMasterKey: true });
    detach(deps, 'chooseDriver', deps.dispatch.start({ objectId: orderId }));
    return 1;
  },

  // `data` is forwarded untouched: an unknown `data.icon` crashes installed app builds, and it is
  // the sender's job not to send one (switch-ops sends none).
  async sendPush(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { title, body, data, imageUrl, userId, cityId, appType } = req.params as Record<
      string,
      unknown
    >;
    let token: unknown, topic: unknown, condition: unknown;
    if (userId && appType) {
      const query = new Parse.Query(Parse.User);
      query.equalTo('objectId', userId);
      const userObj = await query.first({ useMasterKey: true });
      if (!userObj) throw CLOUD_ERRORS.USER_DOES_NOT_EXISTS;
      token = userObj.get('pushToken')[appType as string];
      if (!token) throw CLOUD_ERRORS.USER_PUSH_TOKEN_MISSING;
    } else if (cityId && appType) {
      // Q-5: built by string interpolation, as legacy.
      condition = `'${appType as string}' in topics && '${cityId as string}' in topics`;
    } else if (appType) {
      topic = appType;
    }
    sendPush(deps, { title, body, token, topic, condition, data, imageUrl });
    return 1;
  },
};
