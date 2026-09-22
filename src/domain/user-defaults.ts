/**
 * New-user defaults (inventory §3.4). Legacy repeats this literal in loginWithGoogle/Facebook/Apple,
 * addUser and the loginStaff bootstrap; each caller overrides a few keys. The `undefined` entries
 * are kept on purpose: legacy calls `user.set(key, undefined)` for them.
 *
 * Key order matches legacy's `set` order.
 */
export function newUserFields(overrides: {
  username: unknown;
  password: unknown;
  fullname: unknown;
  email: unknown;
  language: unknown;
  appType: unknown;
  enabled?: unknown;
  phone?: unknown;
  city?: unknown;
  staffType?: unknown;
}): Record<string, unknown> {
  return {
    username: overrides.username,
    fullname: overrides.fullname,
    password: overrides.password,
    email: overrides.email,
    language: overrides.language,
    appType: overrides.appType,
    enabled: 'enabled' in overrides ? overrides.enabled : true,
    pushToken: {},
    theme: 'light',
    phone: overrides.phone,
    picture: undefined,
    address: undefined,
    city: overrides.city,
    promoNotifs: true,
    payment: { method: 'cash', stripeCustomerId: null, stripeDefaultSourceId: null, list: [] },
    cartOptions: {},
    cartFood: [],
    favorites: [],
    promosUsed: [],
    managerStore: undefined,
    driverActive: false,
    driverRating: 0,
    driverLocation: undefined,
    driverOrdersAccepted: 0,
    driverParams: { ratingTotal: 0, reviews: 0 },
    staffType: overrides.staffType,
  };
}
