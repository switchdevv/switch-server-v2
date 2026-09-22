// Helpers shared by the staff functions: the cascading deletes of users and stores, and the
// manager ACL / file-owner rewrites. Ported from legacy cloud/dashboard/{users,stores,lists,
// products,promos}.js, where each function repeated them inline.
import type { CloudDeps, ParseObject, ParseUser } from './context.js';
import { deleteFileByName } from './functions/files.js';
import { CLASSES, pointer } from './pointers.js';

async function destroyAll(objects: ParseObject[]): Promise<void> {
  for (const obj of objects) await obj.destroy({ useMasterKey: true });
}

/** Destroy a store's lists (afterDelete List cascades to Food), promos and reviews (+pictures). */
export async function destroyStoreContents(deps: CloudDeps, store: ParseObject): Promise<void> {
  const { Parse } = deps;
  const lists = new Parse.Query(CLASSES.list);
  lists.equalTo('restaurant', store);
  await destroyAll(await lists.find({ useMasterKey: true }));
  const promos = new Parse.Query(CLASSES.promo);
  promos.equalTo('restaurant', store);
  await destroyAll(await promos.find({ useMasterKey: true }));
  const reviewsQuery = new Parse.Query(CLASSES.review);
  reviewsQuery.equalTo('restaurant', store);
  for (const obj of await reviewsQuery.find({ useMasterKey: true })) {
    await obj.destroy({ useMasterKey: true });
    if (obj.get('picture')) await deleteFileByName(deps, obj.get('picture').name());
  }
}

/**
 * What goes with a deleted user: sessions, then (food users) addresses, then (drivers) reviews
 * about them. deleteUsers also removes a manager's store between those two steps
 * (`includeManagedStore`); deleteStores already deleted the store itself.
 */
export async function destroyUserContents(
  deps: CloudDeps,
  user: ParseUser,
  { includeManagedStore }: { includeManagedStore: boolean },
): Promise<void> {
  const { Parse } = deps;
  const sessions = new Parse.Query(Parse.Session);
  sessions.equalTo('user', user);
  await destroyAll(await sessions.find({ useMasterKey: true }));
  if (user.get('appType').includes('food')) {
    const addresses = new Parse.Query(CLASSES.address);
    addresses.equalTo('user', user);
    await destroyAll(await addresses.find({ useMasterKey: true }));
  }
  if (includeManagedStore && user.get('managerStore')) {
    const storeQuery = new Parse.Query(CLASSES.store);
    storeQuery.equalTo('objectId', user.get('managerStore').id);
    const store = (await storeQuery.first({ useMasterKey: true }))!;
    await store.destroy({ useMasterKey: true });
    if (store.get('picture')) await deleteFileByName(deps, store.get('picture').name());
    await destroyStoreContents(deps, store);
  }
  if (user.get('appType').includes('driver')) {
    const reviews = new Parse.Query(CLASSES.review);
    reviews.equalTo('driver', user);
    await destroyAll(await reviews.find({ useMasterKey: true }));
  }
}

/** Public read + write for the manager (the lists/products/promos ACL shape). */
export function managerAcl(deps: CloudDeps, managerId: unknown) {
  const acl = new deps.Parse.ACL();
  acl.setPublicReadAccess(true);
  acl.setWriteAccess(managerId as string, true);
  return acl;
}

/** Point the FileObject row of `fileName` at `owner` (legacy: throws if the row is missing). */
export async function reassignFileOwner(
  deps: CloudDeps,
  fileName: unknown,
  owner: ParseObject,
): Promise<void> {
  const query = new deps.Parse.Query(CLASSES.file);
  query.equalTo('fileName', fileName);
  const fileObj = (await query.first({ useMasterKey: true }))!;
  fileObj.set('createdBy', owner);
  await fileObj.save(null, { useMasterKey: true });
}

/** `_User` row whose `managerStore` is the given store id. */
export async function managerOfStore(deps: CloudDeps, storeId: unknown) {
  const query = new deps.Parse.Query(deps.Parse.User);
  query.equalTo('managerStore', pointer(deps.Parse, CLASSES.store, storeId));
  return query.first({ useMasterKey: true });
}
