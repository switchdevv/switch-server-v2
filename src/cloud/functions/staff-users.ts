// Port of legacy cloud/dashboard/users.js and cloud/dashboard/support.js.
import { newUserFields } from '../../domain/user-defaults.js';
import { destroyUserContents } from '../cascade.js';
import { type CloudDeps, detach, type FunctionTable, type ParseUser } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireStaff } from '../guards.js';
import { CLASSES, pointer } from '../pointers.js';
import { deleteFileByName } from './files.js';

/** Legacy adds users to the Staff role without awaiting the save. */
async function addToStaffRole(deps: CloudDeps, user: ParseUser): Promise<void> {
  const { Parse } = deps;
  const query = new Parse.Query(Parse.Role);
  query.equalTo('name', deps.env.STAFF_ROLE_NAME);
  const staffRole = (await query.first({ useMasterKey: true }))!;
  staffRole.getUsers().add(user);
  detach(deps, 'staffRole.save', staffRole.save(null, { useMasterKey: true }));
}

export const staffUserFunctions: FunctionTable = {
  async getUsers(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { limit, skip, search, fullText, appType, disabled, driverActive, cityId } =
      req.params as Record<string, unknown>;
    if (limit === undefined || skip === undefined) throw CLOUD_ERRORS.PARAMS_MISSING;
    const query = new Parse.Query(Parse.User);
    query.descending('createdAt');
    query.include('city');
    query.include('address');
    query.include('managerStore');
    if (appType) query.equalTo('appType', appType);
    if (disabled) query.equalTo('enabled', false);
    if (driverActive) query.equalTo('driverActive', true);
    if (cityId) query.equalTo('city', pointer(Parse, CLASSES.region, cityId));
    query.limit(limit as number);
    query.skip(skip as number);
    if (search) {
      const { key, value } = search as { key: string; value: string };
      if (fullText) query.fullText(key, value);
      else query.startsWith(key, value);
    }
    query.withCount();
    const data = (await query.find({ useMasterKey: true })) as unknown as {
      count: number;
      results: ParseUser[];
    };
    return { count: data.count, results: data.results.map((item) => item.toJSON()) };
  },

  async addUser(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { fullname, username, password, email, appType, cityId, enabled, staffType, phone } =
      req.params as Record<string, unknown>;
    if (
      !fullname ||
      !username ||
      !password ||
      !email ||
      !appType ||
      !cityId ||
      enabled === undefined
    ) {
      throw CLOUD_ERRORS.PARAMS_MISSING;
    }
    const signedUser = new Parse.User();
    const fields = newUserFields({
      username,
      password,
      fullname,
      email,
      language: 'en',
      appType,
      enabled,
      phone,
      city: pointer(Parse, CLASSES.region, cityId),
      staffType,
    });
    for (const [key, value] of Object.entries(fields)) signedUser.set(key, value);
    // verifyUserEmails is on, so Parse sends the verification email here.
    await signedUser.signUp(null, { useMasterKey: true });
    if (staffType) await addToStaffRole(deps, signedUser);
    return 1;
  },

  async editUser(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { id, fullname, email, phone, appType, cityId, staffType, password } =
      req.params as Record<string, unknown>;
    if (!id || !fullname || !email || !phone || !appType || !cityId)
      throw CLOUD_ERRORS.PARAMS_MISSING;
    const userQuery = new Parse.Query(Parse.User);
    userQuery.equalTo('objectId', id);
    const user = (await userQuery.first({ useMasterKey: true }))!;
    user.set('fullname', fullname);
    user.set('phone', phone);
    user.set('appType', appType);
    if (user.get('email') !== email) user.set('email', email);
    user.set('city', pointer(Parse, CLASSES.region, cityId));
    // An omitted staffType is left alone, not cleared: `set(key, undefined)` sends no key, as over
    // legacy's HTTP (wire-json.ts). To be confirmed against legacy in the parity harness.
    user.set('staffType', staffType);
    if (password) user.set('password', password);
    await user.save(null, { useMasterKey: true });
    // Never removes from the role.
    if (staffType) await addToStaffRole(deps, user);
    return 1;
  },

  async deleteUsers(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new Parse.Query(Parse.User);
      query.equalTo('objectId', id);
      const user = (await query.first({ useMasterKey: true }))!;
      await user.destroy({ useMasterKey: true });
      if (user.get('picture')) await deleteFileByName(deps, user.get('picture').name());
      await destroyUserContents(deps, user, { includeManagedStore: true });
    }
    return 1;
  },

  async toggleEnableUsers(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new Parse.Query(Parse.User);
      query.equalTo('objectId', id);
      const user = (await query.first({ useMasterKey: true }))!;
      const newEnabled = !user.get('enabled');
      user.set('enabled', newEnabled);
      if (!newEnabled) user.set('driverActive', false);
      await user.save(null, { useMasterKey: true });
      if (user.get('managerStore')) {
        const query2 = new Parse.Query(CLASSES.store);
        query2.equalTo('objectId', user.get('managerStore').id);
        const store = (await query2.first({ useMasterKey: true }))!;
        store.set('enabled', newEnabled);
        await store.save(null, { useMasterKey: true });
        // Food only, not List (unlike toggleEnableStores).
        const query3 = new Parse.Query(CLASSES.product);
        query3.equalTo('restaurant', store);
        for (const obj of await query3.find({ useMasterKey: true })) {
          obj.set('enabled', newEnabled);
          await obj.save(null, { useMasterKey: true });
        }
      }
    }
    return 1;
  },

  async deleteMessages(req, deps) {
    const { Parse } = deps;
    await requireStaff(req, deps);
    const { ids } = req.params as Record<string, unknown>;
    if (!ids) throw CLOUD_ERRORS.PARAMS_MISSING;
    for (const id of ids as unknown[]) {
      const query = new Parse.Query(CLASSES.message);
      query.equalTo('objectId', id);
      const obj = (await query.first({ useMasterKey: true }))!;
      await obj.destroy({ useMasterKey: true });
    }
    return 1;
  },
};
