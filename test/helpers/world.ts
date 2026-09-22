import { type Client, geo, ptr } from './client.js';

/** New-user defaults, as the apps' users carry them (inventory §3.4). */
const defaults = {
  enabled: true,
  pushToken: {},
  theme: 'light',
  promoNotifs: true,
  payment: { method: 'cash', stripeCustomerId: null, stripeDefaultSourceId: null, list: [] },
  cartOptions: {},
  cartFood: [],
  favorites: [],
  promosUsed: [],
  driverActive: false,
  driverRating: 0,
  driverOrdersAccepted: 0,
  driverParams: { ratingTotal: 0, reviews: 0 },
};

let seq = 0;

/** Only master-key writes may set these (`beforeSave _User`), so makeUser sets them after signup. */
const PROTECTED = ['staffType', 'opsAccess', 'financeAccess'];

export async function makeUser(api: Client, allFields: Record<string, unknown>) {
  const n = ++seq;
  const fields = Object.fromEntries(
    Object.entries(allFields).filter(([key]) => !PROTECTED.includes(key)),
  );
  const protectedFields = Object.fromEntries(
    Object.entries(allFields).filter(([key]) => PROTECTED.includes(key)),
  );
  const username = (fields.username as string | undefined) ?? `user${n}`;
  const password = (fields.password as string | undefined) ?? `pass${n}`;
  const { id, session } = await api.signUp({
    username,
    password,
    email: fields.email ?? `${username}@example.test`,
    language: 'en',
    ...defaults,
    ...fields,
  });
  if (Object.keys(protectedFields).length) await api.update('_User', id, protectedFields);
  return { id, session, username, password };
}

export const RESTAURANT_LOCATION = { latitude: 36.75, longitude: 3.06 };

/** A small, deterministic world: a city, a store with a manager, a customer, staff, drivers. */
export async function makeWorld(api: Client) {
  // Order columns prod already has (tools/seed/schema.json). Driver claims write them in Parse's
  // storage format (src/cloud/order-claims.ts), so nothing adds them on first save here.
  const schemaRes = await api.request(
    'POST',
    '/schemas/Order',
    {
      className: 'Order',
      fields: {
        driver: { type: 'Pointer', targetClass: '_User' },
        canceled: { type: 'Boolean' },
      },
    },
    { master: true },
  );
  if (schemaRes.status !== 200)
    throw new Error(`Order schema failed: ${JSON.stringify(schemaRes.body)}`);

  const cityId = await api.create('City', {
    name: 'Alger',
    fees: {
      food: { initial: 150, minKms: 3, perExtraKm: 30, initialExtra: 250, minKmsExtra: 6 },
      grocery: { initial: 200, minKms: 2, perExtraKm: 50 },
    },
  });
  const city = ptr('City', cityId);

  const staffUser = await makeUser(api, {
    appType: ['staff'],
    staffType: 'Admin',
    city,
    pushToken: { staff: 'tok-staff' },
  });
  const roleRes = await api.request<{ objectId: string }>(
    'POST',
    '/roles',
    {
      name: 'Staff',
      ACL: {},
      users: { __op: 'AddRelation', objects: [ptr('_User', staffUser.id)] },
    },
    { master: true },
  );
  const staffRoleId = roleRes.body.objectId;

  const manager = await makeUser(api, {
    appType: ['manager'],
    city,
    pushToken: { manager: 'tok-manager' },
  });
  const storeId = await api.create('Restaurant', {
    name: 'Chez Test',
    enabled: true,
    manager: ptr('_User', manager.id),
    city,
    location: geo(RESTAURANT_LOCATION.latitude, RESTAURANT_LOCATION.longitude),
    ordersTotal: 0,
    ordersAccepted: 0,
    ratingTotal: 0,
    reviews: 0,
    rating: 0,
    isDiscount: false,
    isPromo: false,
  });
  await api.update('_User', manager.id, { managerStore: ptr('Restaurant', storeId) });

  const customer = await makeUser(api, {
    appType: ['food'],
    city,
    pushToken: { food: 'tok-customer' },
  });
  const addressId = await api.create('Address', { user: ptr('_User', customer.id), name: 'Home' });

  const listId = await api.create('List', {
    name: 'Pizzas',
    restaurant: ptr('Restaurant', storeId),
    enabled: true,
  });
  const foodId = await api.create('Food', {
    name: 'Margherita',
    restaurant: ptr('Restaurant', storeId),
    list: ptr('List', listId),
    city,
    price: 800,
    enabled: true,
    isDiscount: false,
  });

  return {
    cityId,
    city,
    staffUser,
    staffRoleId,
    manager,
    storeId,
    customer,
    addressId,
    listId,
    foodId,
  };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** A driver placed `km` kilometres north of the restaurant. */
export async function makeDriver(api: Client, km: number, fields: Record<string, unknown> = {}) {
  const latitude = RESTAURANT_LOCATION.latitude + km / 111.2;
  return makeUser(api, {
    appType: ['driver'],
    driverActive: true,
    driverLocation: geo(latitude, RESTAURANT_LOCATION.longitude),
    pushToken: { driver: `tok-driver-${km}` },
    ...fields,
  });
}

export async function placeOrder(api: Client, w: World, extra: Record<string, unknown> = {}) {
  const res = await api.fn(
    'placeOrder',
    {
      userId: w.customer.id,
      restaurantId: w.storeId,
      userAddressId: w.addressId,
      foodIds: [w.foodId],
      deliveryType: 'delivery',
      type: 'food',
      options: { note: 'no onions' },
      distance: 3.2,
      duration: 20,
      ...extra,
    },
    w.customer.session,
  );
  if (res.body.result !== 1) throw new Error(`placeOrder failed: ${JSON.stringify(res.body)}`);
  const orders = await api.find('Order', { user: ptr('_User', w.customer.id) });
  const last = orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]!;
  return last.objectId as string;
}
