// Port of legacy cloud/dashboard/stores.js.
import {
  destroyStoreContents,
  destroyUserContents,
  managerAcl,
  managerOfStore,
  reassignFileOwner,
} from '../cascade.js';
import type { FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireStaff } from '../guards.js';
import { CLASSES, pointer } from '../pointers.js';
import { deleteFileByName } from './files.js';

export const staffStoreFunctions: FunctionTable = {
  async deleteStores(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new Parse.Query(CLASSES.store);
      query.equalTo('objectId', id);
      const store = (await query.first({ useMasterKey: true }))!;
      await store.destroy({ useMasterKey: true });
      if (store.get('picture')) await deleteFileByName(deps, store.get('picture').name());
      if (store.get('manager')) {
        const query2 = new Parse.Query(Parse.User);
        query2.equalTo('objectId', store.get('manager').id);
        const user = (await query2.first({ useMasterKey: true }))!;
        await user.destroy({ useMasterKey: true });
        if (user.get('picture')) await deleteFileByName(deps, user.get('picture').name());
        await destroyUserContents(deps, user, { includeManagedStore: false });
      }
      await destroyStoreContents(deps, store);
    }
    return 1;
  },

  async toggleEnableStores(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new Parse.Query(CLASSES.store);
      query.equalTo('objectId', id);
      const store = (await query.first({ useMasterKey: true }))!;
      const newEnabled = !store.get('enabled');
      store.set('enabled', newEnabled);
      await store.save(null, { useMasterKey: true });
      if (store.get('manager')) {
        const query2 = new Parse.Query(Parse.User);
        query2.equalTo('objectId', store.get('manager').id);
        const user = (await query2.first({ useMasterKey: true }))!;
        user.set('enabled', newEnabled);
        if (!newEnabled) user.set('driverActive', false);
        await user.save(null, { useMasterKey: true });
      }
      for (const className of [CLASSES.list, CLASSES.product]) {
        const query3 = new Parse.Query(className);
        query3.equalTo('restaurant', store);
        for (const obj of await query3.find({ useMasterKey: true })) {
          obj.set('enabled', newEnabled);
          await obj.save(null, { useMasterKey: true });
        }
      }
    }
    return 1;
  },

  async assignManager(req, deps) {
    const { Parse, env } = deps;
    await requireStaff(req, deps);
    const { storeId, managerId } = req.params as Record<string, unknown>;
    if (!storeId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(CLASSES.store);
    query.equalTo('objectId', storeId);
    const store = (await query.first({ useMasterKey: true }))!;
    if (store.get('manager')) {
      const query2 = new Parse.Query(Parse.User);
      query2.equalTo('objectId', store.get('manager').id);
      const oldManager = (await query2.first({ useMasterKey: true }))!;
      oldManager.set('managerStore', null);
      oldManager.set(
        'appType',
        (oldManager.get('appType') as unknown[]).filter((item) => item !== 'manager'),
      );
      await oldManager.save(null, { useMasterKey: true });
    }
    if (!managerId) {
      store.set('manager', null);
      await store.save(null, { useMasterKey: true });
      return 1;
    }
    const query2 = new Parse.Query(Parse.User);
    query2.equalTo('objectId', managerId);
    const manager = (await query2.first({ useMasterKey: true }))!;
    store.set('manager', manager);
    const acl = managerAcl(deps, managerId);
    acl.setRoleWriteAccess(env.STAFF_ROLE_NAME, true);
    store.setACL(acl);
    await store.save(null, { useMasterKey: true });
    manager.set('managerStore', store);
    if (!manager.get('appType').includes('manager'))
      manager.set('appType', [...manager.get('appType'), 'manager']);
    await manager.save(null, { useMasterKey: true });
    if (store.get('picture')) await reassignFileOwner(deps, store.get('picture').name(), manager);

    const lists = new Parse.Query(CLASSES.list);
    lists.equalTo('restaurant', store);
    for (const obj of await lists.find({ useMasterKey: true })) {
      obj.setACL(managerAcl(deps, managerId));
      await obj.save(null, { useMasterKey: true });
    }
    const food = new Parse.Query(CLASSES.product);
    food.equalTo('restaurant', store);
    for (const obj of await food.find({ useMasterKey: true })) {
      obj.setACL(managerAcl(deps, managerId));
      await obj.save(null, { useMasterKey: true });
      if (obj.get('picture')) await reassignFileOwner(deps, obj.get('picture').name(), manager);
    }
    const promos = new Parse.Query(CLASSES.promo);
    promos.equalTo('restaurant', store);
    for (const obj of await promos.find({ useMasterKey: true })) {
      obj.setACL(managerAcl(deps, managerId));
      await obj.save(null, { useMasterKey: true });
    }
    return 1;
  },

  async assignStoreFile(req, deps) {
    await requireStaff(req, deps);
    const { filename, storeId } = req.params as Record<string, unknown>;
    if (!filename || !storeId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const manager = await managerOfStore(deps, storeId);
    if (manager) await reassignFileOwner(deps, filename, manager);
    return 1;
  },

  async changeRegion(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { storeId, cityId } = req.params as Record<string, unknown>;
    if (!storeId || !cityId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const city = pointer(Parse, CLASSES.region, cityId);
    const query = new Parse.Query(CLASSES.store);
    query.equalTo('objectId', storeId);
    const store = (await query.first({ useMasterKey: true }))!;
    store.set('city', city);
    await store.save(null, { useMasterKey: true });
    const food = new Parse.Query(CLASSES.product);
    food.equalTo('restaurant', store);
    for (const obj of await food.find({ useMasterKey: true })) {
      obj.set('city', city);
      await obj.save(null, { useMasterKey: true });
    }
    return 1;
  },
};
