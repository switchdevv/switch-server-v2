// Port of legacy cloud/dashboard/auth.js and cloud/dashboard/configs.js.
import { newUserFields } from '../../domain/user-defaults.js';
import { detach, type FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { findRole, requireStaff } from '../guards.js';

/** Written once, when `loginStaff` bootstraps an empty database. Never at boot (plan R4). */
export const BOOTSTRAP_CONFIG = {
  tripDuration: { preparationTime: 10, timePerKm: 3 },
  supportNumbers: [],
  storeUrls: {
    food: { android: '', ios: '' },
    driver: { android: '', ios: '' },
    manager: { android: '', ios: '' },
  },
  pickupEnabled: true,
  homeSections: false,
  cartFloatButton: true,
  driverRealtime: true,
  noDriverHandleAdmin: false,
  sendNotifsToAll: false,
  sendManagerNotifs: false,
  showSmsHashButton: false,
  supplementsAutoComplete: [],
};

export const staffAuthFunctions: FunctionTable = {
  async loginStaff(req, deps) {
    const { Parse, env } = deps;
    const { username, password } = req.params as Record<string, unknown>;
    if (!username || !password) throw CLOUD_ERRORS.LOGIN_STAFF_PARAMS_MISSING;
    const usersCount = await new Parse.Query(Parse.User).count({ useMasterKey: true });
    if (usersCount > 0) {
      const userQuery = new Parse.Query(Parse.User);
      userQuery.equalTo('username', username);
      const user = await userQuery.first({ useMasterKey: true });
      if (!user) throw CLOUD_ERRORS.USER_DOES_NOT_EXISTS;
      const role = await findRole(deps, user);
      if (!role) throw CLOUD_ERRORS.USER_UNAUTHORIZED;
      // Goes through /login, so beforeLogin runs; a wrong password is Parse's own 101.
      const loggedUser = await Parse.User.logIn(username as string, password as string);
      return { sessionToken: loggedUser.getSessionToken() };
    }

    // Empty database: create the Config, the first admin and the Staff role.
    // No masterKeyOnly flags, as legacy.
    await Parse.Config.save(BOOTSTRAP_CONFIG, undefined as never);
    const signedUser = new Parse.User();
    const fields = newUserFields({
      username,
      password,
      fullname: username,
      email: env.ADMIN_EMAIL,
      language: 'en',
      appType: [env.ADMIN_APP_TYPE],
      staffType: env.ADMIN_STAFF_TYPE,
    });
    for (const [key, value] of Object.entries(fields)) signedUser.set(key, value);
    await signedUser.signUp(null, { useMasterKey: true });
    const role = new Parse.Role(env.STAFF_ROLE_NAME, new Parse.ACL());
    role.getUsers().add(signedUser);
    detach(deps, 'role.save', role.save(null, { useMasterKey: true }));
    const loggedUser = await Parse.User.logIn(username as string, password as string);
    return { sessionToken: loggedUser.getSessionToken() };
  },

  async updateConfigs(req, deps) {
    await requireStaff(req, deps);
    const { configs } = req.params as Record<string, unknown>;
    if (!configs) throw CLOUD_ERRORS.PARAMS_MISSING;
    // Q-9: the second argument is the SDK's masterKeyOnly map, so this also stores
    // `masterKeyOnly.useMasterKey = true`. Harmless, kept for exact DB parity.
    await deps.Parse.Config.save(configs as Record<string, unknown>, { useMasterKey: true });
    return 1;
  },
};
