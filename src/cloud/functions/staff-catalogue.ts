// Port of legacy cloud/dashboard/{lists,products,promos,reviews}.js and cloud/promo/promo.js (uniquePromo).
import { managerAcl, managerOfStore, reassignFileOwner } from '../cascade.js';
import type { CloudDeps, FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireStaff, requireUser } from '../guards.js';
import { CLASSES, pointer } from '../pointers.js';
import { deleteFileByName } from './files.js';

/**
 * Q-1: legacy guards edit* with `Object.keys(req.params) <= 1 || !req.params.id`. Comparing an
 * array to a number is always false for 2+ keys and coerces the array otherwise, so in practice
 * only `id` is required. Reproduced literally rather than "fixed".
 */
function legacyEditParamsMissing(params: Record<string, unknown>): boolean {
  const keys = Object.keys(params) as unknown as number;
  return keys <= 1 || !params.id;
}

async function destroyByIds(
  deps: CloudDeps,
  className: string,
  ids: unknown,
  withPicture: boolean,
): Promise<void> {
  for (const id of ids as unknown[]) {
    const query = new deps.Parse.Query(className);
    query.equalTo('objectId', id);
    const obj = (await query.first({ useMasterKey: true }))!;
    await obj.destroy({ useMasterKey: true });
    if (withPicture && obj.get('picture')) await deleteFileByName(deps, obj.get('picture').name());
  }
}

/** Q-2: set every param except `id` as a field, with the master key. */
async function massAssign(
  deps: CloudDeps,
  className: string,
  params: Record<string, unknown>,
): Promise<void> {
  const query = new deps.Parse.Query(className);
  query.equalTo('objectId', params.id);
  const obj = (await query.first({ useMasterKey: true }))!;
  for (const key in params) {
    if (key !== 'id') obj.set(key, params[key]);
  }
  await obj.save(null, { useMasterKey: true });
}

export const staffCatalogueFunctions: FunctionTable = {
  // Lists
  async editList(req, deps) {
    await requireStaff(req, deps);
    const params = req.params as Record<string, unknown>;
    if (legacyEditParamsMissing(params)) throw CLOUD_ERRORS.PARAMS_MISSING;
    await massAssign(deps, CLASSES.list, params);
    return 1;
  },

  async assignList(req, deps) {
    await requireStaff(req, deps);
    const { id, restaurantId } = req.params as Record<string, unknown>;
    if (!id || !restaurantId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const manager = await managerOfStore(deps, restaurantId);
    if (manager) {
      const query = new deps.Parse.Query(CLASSES.list);
      query.equalTo('objectId', id);
      const list = (await query.first({ useMasterKey: true }))!;
      list.setACL(managerAcl(deps, manager.id));
      await list.save(null, { useMasterKey: true });
    }
    return 1;
  },

  // Lower-case `l` in the name is contract.
  async deletelists(req, deps) {
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    await destroyByIds(deps, CLASSES.list, ids, false);
    return 1;
  },

  // Products
  async editProduct(req, deps) {
    await requireStaff(req, deps);
    const params = req.params as Record<string, unknown>;
    if (legacyEditParamsMissing(params)) throw CLOUD_ERRORS.PARAMS_MISSING;
    await massAssign(deps, CLASSES.product, params);
    return 1;
  },

  async assignProduct(req, deps) {
    await requireStaff(req, deps);
    const { id, restaurantId } = req.params as Record<string, unknown>;
    if (!id || !restaurantId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const manager = await managerOfStore(deps, restaurantId);
    if (manager) {
      const query = new deps.Parse.Query(CLASSES.product);
      query.equalTo('objectId', id);
      const product = (await query.first({ useMasterKey: true }))!;
      product.setACL(managerAcl(deps, manager.id));
      await product.save(null, { useMasterKey: true });
      if (product.get('picture'))
        await reassignFileOwner(deps, product.get('picture').name(), manager);
    }
    return 1;
  },

  async deleteProducts(req, deps) {
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    await destroyByIds(deps, CLASSES.product, ids, true);
    return 1;
  },

  async duplicateProduct(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { id } = req.params as Record<string, unknown>;
    if (!id) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(CLASSES.product);
    query.equalTo('objectId', id);
    const obj = await query.first({ useMasterKey: true });
    if (obj) {
      // toJSON() carries the ACL (copied) and createdAt/updatedAt (ignored by `set`).
      const newData = obj.toJSON() as Record<string, unknown>;
      delete newData.objectId;
      delete newData.picture;
      const newObj = new Parse.Object(CLASSES.product);
      newObj.set(newData);
      await newObj.save(null, { useMasterKey: true });
    }
    return 1;
  },

  // Promos
  async uniquePromo(req, deps) {
    requireUser(req);
    const { code } = req.params as Record<string, unknown>;
    if (!code) throw CLOUD_ERRORS.MISSING_PARAMS;
    const query = new deps.Parse.Query(CLASSES.promo);
    query.equalTo('code', code);
    const count = await query.count({ useMasterKey: true });
    if (count > 0) throw CLOUD_ERRORS.PROMO_EXISTS;
    return 1;
  },

  async editPromo(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const params = req.params as Record<string, unknown>;
    if (legacyEditParamsMissing(params)) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(CLASSES.promo);
    query.equalTo('objectId', params.id);
    const promo = (await query.first({ useMasterKey: true }))!;
    promo.set('city', null);
    promo.set('restaurant', null);
    promo.set('food', null);
    for (const key in params) {
      if (key === 'cityId') promo.set('city', pointer(Parse, CLASSES.region, params.cityId));
      else if (key === 'restaurantId')
        promo.set('restaurant', pointer(Parse, CLASSES.store, params.restaurantId));
      else if (key === 'foodId') promo.set('food', pointer(Parse, CLASSES.product, params.foodId));
      else if (key === 'expirationDate')
        promo.set('expirationDate', new Date(params.expirationDate as string));
      else if (key !== 'id' && key !== 'code') promo.set(key, params[key]);
    }
    await promo.save(null, { useMasterKey: true });
    return 1;
  },

  async assignPromo(req, deps) {
    await requireStaff(req, deps);
    const { id, restaurantId } = req.params as Record<string, unknown>;
    if (!id || !restaurantId) throw CLOUD_ERRORS.PARAMS_MISSING;
    const manager = await managerOfStore(deps, restaurantId);
    if (manager) {
      const query = new deps.Parse.Query(CLASSES.promo);
      query.equalTo('objectId', id);
      const promo = (await query.first({ useMasterKey: true }))!;
      promo.setACL(managerAcl(deps, manager.id));
      await promo.save(null, { useMasterKey: true });
    }
    return 1;
  },

  async deletePromos(req, deps) {
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    await destroyByIds(deps, CLASSES.promo, ids, false);
    return 1;
  },

  // Reviews
  async deleteReviews(req, deps) {
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    await destroyByIds(deps, CLASSES.review, ids, true);
    return 1;
  },
};
