// A deterministic local world for running the apps and dashboards against a local v2 server:
// the production schema and permissions, two cities, three restaurants with menus and managers,
// three online drivers, customers, ops staff, a promo, a support message and a month of orders.
//
// Local only: refuses any server that is not on this machine. It talks to the server over REST
// (as the apps do) and uses the real cloud functions where they exist (loginStaff, addUser,
// assignManager), so the data goes through v2's own logic. Only order dates are written to
// MongoDB directly, because Parse never lets a client set `createdAt`.
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

export interface SeedTarget {
  serverUrl: string;
  appId: string;
  masterKey: string;
  databaseUri: string;
  /** Password of every seeded account. */
  password: string;
}

export interface SeedLogin {
  who: string;
  username: string;
  app: string;
}

/** Every seeded account (all share the seed password). */
export const SEED_LOGINS: SeedLogin[] = [
  { who: 'Admin (staff)', username: 'admin', app: 'dashboard, ops, finance' },
  { who: 'Ops staff (ops + finance access)', username: 'ops', app: 'dashboard, ops, finance' },
  { who: 'Manager of Pizza Roma', username: 'manager.roma', app: 'switch-manager' },
  { who: 'Manager of Burger House', username: 'manager.burger', app: 'switch-manager' },
  { who: 'Manager of Dar El Couscous (Oran)', username: 'manager.couscous', app: 'switch-manager' },
  { who: 'Driver 0.5 km from Pizza Roma', username: 'driver.amine', app: 'switch-driver' },
  { who: 'Driver 2 km from Pizza Roma', username: 'driver.sara', app: 'switch-driver' },
  { who: 'Driver 4 km from Pizza Roma', username: 'driver.yacine', app: 'switch-driver' },
  { who: 'Customer (Alger, has an address)', username: 'customer', app: 'switch-food' },
  { who: 'Disabled customer (login refused)', username: 'customer.disabled', app: 'switch-food' },
];

interface SchemaClass {
  className: string;
  fields: Record<string, Record<string, unknown>>;
  classLevelPermissions?: Record<string, unknown>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const ptr = (className: string, objectId: string) => ({ __type: 'Pointer', className, objectId });
const geo = (latitude: number, longitude: number) => ({ __type: 'GeoPoint', latitude, longitude });
const DAY_MS = 24 * 60 * 60 * 1000;

/** Columns Parse Server defines itself on its system classes; a schema call may not re-add them. */
const PARSE_BUILT_IN: Record<string, Record<string, true>> = {
  _User: { username: true, password: true, email: true, emailVerified: true, authData: true },
  _Role: { name: true, users: true, roles: true },
  _Session: {
    user: true,
    installationId: true,
    sessionToken: true,
    expiresAt: true,
    createdWith: true,
    restricted: true,
  },
};

/** Degrees of latitude per km, for placing drivers north of a restaurant. */
const KM_LAT = 1 / 111.0;

/** A square geofence around a point, as Parse Polygon [lat, lng] pairs. */
function square(lat: number, lng: number, halfDeg: number) {
  return {
    __type: 'Polygon',
    coordinates: [
      [lat - halfDeg, lng - halfDeg],
      [lat - halfDeg, lng + halfDeg],
      [lat + halfDeg, lng + halfDeg],
      [lat + halfDeg, lng - halfDeg],
    ],
  };
}

/** Small deterministic PRNG so every run produces the same orders. */
function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function seedLocalWorld(target: SeedTarget): Promise<void> {
  const host = new URL(target.serverUrl).hostname;
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`The local seed only runs against this machine (got ${host}).`);

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    auth: { master?: boolean; session?: string } = { master: true },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'X-Parse-Application-Id': target.appId,
      'Content-Type': 'application/json',
    };
    if (auth.master) headers['X-Parse-Master-Key'] = target.masterKey;
    if (auth.session) headers['X-Parse-Session-Token'] = auth.session;
    const res = await fetch(target.serverUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string; code?: number };
    if (!res.ok)
      throw new Error(`${method} ${path}: ${res.status} ${json.code ?? ''} ${json.error ?? ''}`);
    return json;
  }
  const create = async (className: string, data: Record<string, unknown>) =>
    (await call<{ objectId: string }>('POST', `/classes/${className}`, data)).objectId;
  const fn = async (name: string, params: Record<string, unknown>, session?: string) =>
    (
      await call<{ result: unknown }>(
        'POST',
        `/functions/${name}`,
        params,
        session ? { session } : {},
      )
    ).result;

  // 1. Schema and class-level permissions, as in production.
  const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')) as {
    classes: SchemaClass[];
  };
  const existing = await call<{
    results: { className: string; fields: Record<string, unknown> }[];
  }>('GET', '/schemas');
  const known = new Map(existing.results.map((c) => [c.className, c.fields]));
  for (const cls of schema.classes) {
    const have = { ...PARSE_BUILT_IN[cls.className], ...known.get(cls.className) };
    if (known.has(cls.className) || cls.className in PARSE_BUILT_IN) {
      const fields = Object.fromEntries(
        Object.entries(cls.fields).filter(([name]) => !(name in have)),
      );
      const method = known.has(cls.className) ? 'PUT' : 'POST';
      await call(method, `/schemas/${cls.className}`, {
        fields,
        classLevelPermissions: cls.classLevelPermissions,
      });
    } else {
      await call('POST', `/schemas/${cls.className}`, cls);
    }
  }

  // 2. The first admin, through the dashboard's own bootstrap (Config + Staff role).
  const adminLogin = (await fn('loginStaff', { username: 'admin', password: target.password })) as {
    sessionToken: string;
  };
  const admin = adminLogin.sessionToken;
  // loginStaff saves the Staff role without waiting for it (legacy); staff calls need it.
  for (let i = 0; i < 100; i++) {
    const roles = await call<{ results: unknown[] }>(
      'GET',
      '/roles?where=' + encodeURIComponent('{"name":"Staff"}'),
    );
    if (roles.results.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  // 3. Cities. Alger has the two-tier delivery table, Oran the one-tier one.
  const algerFees = {
    initial: 150,
    minKms: 3,
    perExtraKm: 30,
    initialExtra: 250,
    minKmsExtra: 6,
    service: 50,
    servicePickup: 20,
  };
  const oranFees = {
    initial: 120,
    minKms: 3,
    perExtraKm: 25,
    minKmsExtra: null,
    service: 40,
    servicePickup: 20,
  };
  const feesFor = (food: object) => ({ food, driver: food, manager: food });
  const alger = await create('City', {
    name: 'Alger',
    currency: 'dzd',
    zoom: 12,
    fees: feesFor(algerFees),
    geofence: square(36.7538, 3.0588, 0.15),
  });
  const oran = await create('City', {
    name: 'Oran',
    currency: 'dzd',
    zoom: 12,
    fees: feesFor(oranFees),
    geofence: square(35.6971, -0.6308, 0.12),
  });

  // 4. Categories.
  const categories: Record<string, string> = {};
  for (const [key, translations] of Object.entries({
    pizza: { en: 'Pizza', fr: 'Pizza', ar: 'بيتزا' },
    burgers: { en: 'Burgers', fr: 'Burgers', ar: 'برغر' },
    traditional: { en: 'Traditional', fr: 'Traditionnel', ar: 'تقليدي' },
  })) {
    categories[key] = await create('Category', { name: translations.en, translations });
  }

  // 5. Restaurants, lists and dishes (public read; assignManager hands them to the manager).
  const publicRead = { '*': { read: true } };
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const storeSpecs = [
    {
      key: 'roma',
      name: 'Pizza Roma',
      city: alger,
      category: 'pizza',
      at: [36.765, 3.052],
      featured: true,
      lists: {
        Pizzas: [
          ['Margherita', 700],
          ['Quatre fromages', 950],
          ['Pepperoni', 900, 750],
        ],
        Drinks: [
          ['Hamoud Boualem', 100],
          ['Water 1.5L', 60],
        ],
      },
    },
    {
      key: 'burger',
      name: 'Burger House',
      city: alger,
      category: 'burgers',
      at: [36.745, 3.07],
      featured: false,
      lists: {
        Burgers: [
          ['Classic burger', 600],
          ['Double cheese', 850],
          ['Chicken burger', 650],
        ],
        Sides: [
          ['Fries', 200],
          ['Onion rings', 250],
        ],
      },
    },
    {
      key: 'couscous',
      name: 'Dar El Couscous',
      city: oran,
      category: 'traditional',
      at: [35.699, -0.635],
      featured: false,
      lists: {
        Plats: [
          ['Couscous royal', 1200],
          ['Chorba', 400],
          ['Rechta', 900, 800],
        ],
        Desserts: [['Makroud', 150]],
      },
    },
  ] as const;
  const stores: Record<
    string,
    {
      id: string;
      city: string;
      at: readonly [number, number];
      food: { id: string; price: number }[];
    }
  > = {};
  for (const spec of storeSpecs) {
    const id = await create('Restaurant', {
      name: spec.name,
      searchName: spec.name.toLowerCase(),
      description: `${spec.name} (local seed)`,
      address: 'Local seed street',
      phone: '0550000000',
      city: ptr('City', spec.city),
      location: geo(spec.at[0], spec.at[1]),
      categories: [ptr('Category', categories[spec.category]!)],
      enabled: true,
      active: true,
      workingDays: everyDay,
      openTime: { h: 0, mn: 0 },
      closeTime: { h: 23, mn: 59 },
      rating: 0,
      ratingTotal: 0,
      reviews: 0,
      ordersTotal: 0,
      ordersAccepted: 0,
      fee: 10,
      isPromo: false,
      isDiscount: false,
      isFeatured: spec.featured,
      ACL: publicRead,
    });
    const food: { id: string; price: number }[] = [];
    for (const [listName, dishes] of Object.entries(spec.lists)) {
      const list = await create('List', {
        name: listName,
        restaurant: ptr('Restaurant', id),
        enabled: true,
        ACL: publicRead,
      });
      for (const [name, price, discountPrice] of dishes as readonly (readonly [
        string,
        number,
        number?,
      ])[]) {
        const foodId = await create('Food', {
          name,
          description: `${name}, made locally`,
          price,
          restaurant: ptr('Restaurant', id),
          list: ptr('List', list),
          city: ptr('City', spec.city),
          enabled: true,
          variants: [],
          instructions: [],
          headers: [],
          isDiscount: discountPrice !== undefined,
          ...(discountPrice !== undefined ? { discountPrice } : {}),
          ACL: publicRead,
        });
        food.push({ id: foodId, price: discountPrice ?? price });
      }
    }
    stores[spec.key] = { id, city: spec.city, at: spec.at, food };
  }

  // 6. People, through addUser (new-user defaults, Staff role), then the fields it doesn't take.
  const users: Record<string, string> = {};
  async function addPerson(
    key: string,
    p: {
      fullname: string;
      appType: string[];
      city: string;
      staffType?: string;
      enabled?: boolean;
      phone?: string;
    },
    extra: Record<string, unknown> = {},
  ) {
    const username = key;
    await fn(
      'addUser',
      {
        username,
        password: target.password,
        fullname: p.fullname,
        email: `${key}@switch.test`,
        appType: p.appType,
        cityId: p.city,
        enabled: p.enabled ?? true,
        phone: p.phone ?? '0555000000',
        ...(p.staffType ? { staffType: p.staffType } : {}),
      },
      admin,
    );
    const found = await call<{ results: { objectId: string }[] }>(
      'GET',
      '/users?where=' + encodeURIComponent(JSON.stringify({ username })),
    );
    const id = found.results[0]!.objectId;
    await call('PUT', `/users/${id}`, { emailVerified: true, ...extra });
    users[key] = id;
    return id;
  }
  await addPerson(
    'ops',
    { fullname: 'Ops Operator', appType: ['staff'], city: alger, staffType: 'Staff' },
    { opsAccess: true, financeAccess: true },
  );
  for (const [key, store] of [
    ['manager.roma', 'roma'],
    ['manager.burger', 'burger'],
    ['manager.couscous', 'couscous'],
  ] as const) {
    await addPerson(key, {
      fullname: `Manager ${store}`,
      appType: ['manager'],
      city: stores[store]!.city,
    });
    await fn('assignManager', { storeId: stores[store]!.id, managerId: users[key] }, admin);
  }
  const roma = stores.roma!;
  for (const [key, name, km] of [
    ['driver.amine', 'Amine', 0.5],
    ['driver.sara', 'Sara', 2],
    ['driver.yacine', 'Yacine', 4],
  ] as const) {
    await addPerson(
      key,
      { fullname: `${name} (driver)`, appType: ['driver'], city: alger },
      {
        driverActive: true,
        driverRating: 4.5,
        driverLocation: geo(roma.at[0] + km * KM_LAT, roma.at[1]),
      },
    );
  }
  await addPerson('customer', { fullname: 'Lina Customer', appType: ['food'], city: alger });
  await addPerson('customer.disabled', {
    fullname: 'Disabled Customer',
    appType: ['food'],
    city: alger,
    enabled: false,
  });
  const customer = users.customer!;
  const own = (id: string) => ({ '*': { read: true }, [id]: { read: true, write: true } });
  const home = await create('Address', {
    name: 'Home',
    address: 'Rue Didouche Mourad (seed)',
    location: geo(36.76, 3.056),
    user: ptr('_User', customer),
    ACL: own(customer),
  });
  await call('PUT', `/users/${customer}`, { address: ptr('Address', home) });

  // 7. A promo (afterSave Promo flags the store) and a support message (afterSave Message pushes staff).
  await create('Promo', {
    code: 'WELCOME',
    type: 'percentage',
    useType: 'unlimited',
    appType: 'food',
    value: 20,
    maxDiscountValue: 300,
    minCost: 500,
    restaurant: ptr('Restaurant', roma.id),
    city: ptr('City', alger),
    expirationDate: { __type: 'Date', iso: new Date(Date.now() + 30 * DAY_MS).toISOString() },
  });
  const driverSession = (
    await call<{ sessionToken: string }>(
      'POST',
      '/login',
      { username: 'driver.sara', password: target.password },
      {},
    )
  ).sessionToken;
  await call(
    'POST',
    '/classes/Message',
    {
      user: ptr('_User', users['driver.sara']!),
      fullname: 'Sara (driver)',
      email: 'driver.sara@switch.test',
      phone: '0555000000',
      message: 'The customer is not answering at the door, what should I do?',
    },
    { session: driverSession },
  );

  // 8. Orders: a month of history (for finance and the ops board) and a few open ones.
  const rand = prng(20260921);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const drivers = ['driver.amine', 'driver.sara', 'driver.yacine'].map((k) => users[k]!);
  const storeKeys = ['roma', 'burger', 'couscous'] as const;
  const dated: { id: string; at: Date }[] = [];
  const perStore: Record<string, number> = {};
  const makeOrder = async (i: number, open: boolean) => {
    const storeKey = open ? pick(['roma', 'burger'] as const) : pick(storeKeys);
    const store = stores[storeKey]!;
    const lines = [pick(store.food), pick(store.food)];
    const values = lines.map((f) => {
      const quantity = 1 + Math.floor(rand() * 2);
      return { [f.id]: { quantity, price: f.price * quantity } };
    });
    const itemsTotal = values.reduce((sum, line) => sum + Object.values(line)[0]!.price, 0);
    const pickup = rand() < 0.15;
    const fees = store.city === alger ? algerFees : oranFees;
    const service = pickup ? fees.servicePickup : fees.service;
    const delivery = pickup ? 0 : fees.initial;
    const canceled = !open && rand() < 0.1;
    const status = open ? pick([0, 1, 1, 2]) : canceled ? pick([0, 1]) : 3;
    const withDriver = !pickup && (status >= 2 || (status === 1 && rand() < 0.5));
    const id = await create('Order', {
      user: ptr('_User', customer),
      restaurant: ptr('Restaurant', store.id),
      userAddress: ptr('Address', home),
      food: lines.map((f) => ptr('Food', f.id)),
      deliveryType: pickup ? 'pickup' : 'delivery',
      type: 'food',
      distance: 2 + Math.round(rand() * 40) / 10,
      duration: 25,
      status,
      isReady: status >= 2,
      canceled,
      driverRated: status === 3,
      city: ptr('City', store.city),
      ...(withDriver ? { driver: ptr('_User', pick(drivers)) } : {}),
      options: {
        itemsTotal,
        discount: 0,
        service,
        ...(pickup ? {} : { delivery }),
        total: itemsTotal + service + delivery,
        paymentMethod: 'cash',
        note: '',
        values,
      },
    });
    perStore[store.id] = (perStore[store.id] ?? 0) + 1;
    if (!open) {
      // Spread over the last 30 days, 10:00–22:00 Algiers time (UTC+1).
      const day = new Date(Date.now() - (1 + Math.floor((i / 60) * 30)) * DAY_MS);
      day.setUTCHours(9 + Math.floor(rand() * 12), Math.floor(rand() * 60), 0, 0);
      dated.push({ id, at: day });
    }
  };
  for (let i = 0; i < 60; i++) await makeOrder(i, false);
  for (let i = 0; i < 5; i++) await makeOrder(i, true);
  for (const [storeId, count] of Object.entries(perStore)) {
    await call('PUT', `/classes/Restaurant/${storeId}`, {
      ordersTotal: count,
      ordersAccepted: count,
    });
  }
  const mongo = new MongoClient(target.databaseUri);
  try {
    await mongo.connect();
    const orders = mongo.db().collection<{ _id: string }>('Order');
    for (const { id, at } of dated) {
      await orders.updateOne({ _id: id }, { $set: { _created_at: at, _updated_at: at } });
    }
  } finally {
    await mongo.close();
  }
}
