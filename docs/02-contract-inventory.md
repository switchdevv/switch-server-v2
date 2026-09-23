# switch-server — Contract Inventory (the "must not change" list)

**Status:** baseline, read from source on 2026-09-21.
**Legacy source:** `switch-food/switch-server` @ `5b6927c` (branch `master`, clean tree).
**Clients read:** switch-food, switch-driver, switch-manager, switch-dashboard, switch-ops,
switch-finance (working copies on this machine, same date).

This document lists everything a client, a stored row, or an outside service can observe from
the legacy server. v2 must reproduce every item exactly, unless the item is listed in the
Deviation Register ([01-rewrite-plan.md §9](01-rewrite-plan.md#9-deviation-register)).

> **Baseline caveat.** The ops console's notes already say *"the deployed server may differ from
> the repo copy."* Phase 0 (task P0-1) compares the deployed App Engine version's file hashes with
> this repo before anything else happens. If they differ, this inventory is re-derived from the
> **deployed** source, not the repo.

---

## 1. Transport-level contract

| Item | Legacy value | Notes |
|---|---|---|
| Public URL | `https://api.switchfood.net` (App Engine custom domain) | Hard-coded in the 3 RN apps and the dashboard. ops/finance read `NEXT_PUBLIC_PARSE_SERVER_URL`. |
| Mount path | `/` (Parse mounted at the root: `app.use('/', server)`) | So routes are `/functions/<name>`, `/classes/<Class>`, `/login`, `/files/...`, `/users/me`, `/config`, `/apps/...` |
| App ID | from `configs.parse.appId` | Also compiled into every client. Must not change. |
| Client key | none (clients call `Parse.initialize(appId)` / `(appId, '')`) | The server must not start requiring a client/JS key. |
| Session tokens | revocable `r:...` tokens in `_Session` | Existing sessions must stay valid (same DB, same `sessionLength` 1 year, `expireInactiveSessions` true). switch-food's boot code regex-matches `"sessionToken":"(r:[A-Za-z0-9]+)"`. |
| Error envelope | `{ "code": <n>, "error": "<message>" }` | Cloud code `throw 'STRING'` → `code 141`, `error: 'STRING'` (checked in 4.3 `FunctionsRouter.createResponseObject` and in 9.x via `triggers.resolveError`). |
| Success envelope | `{ "result": <value> }` | All legacy functions return `1` or plain JSON. None returns a `Parse.Object`. |
| Unknown function | `141`, `Invalid function: "<name>"` | switch-ops detects the missing `setOpsAccess` by exactly this text. |
| LiveQuery / GraphQL / Parse Push | **not used** | No `liveQuery`, no `push` adapter, no GraphQL mount. v2 must not turn any of them on. |

### Parse SDK versions talking to the server

| Client | SDK | Notes |
|---|---|---|
| switch-food / -driver / -manager (current source) | `parse ^8.6.0` | **Older store builds are still installed on phones** and use older SDKs. The server must stay compatible with every REST shape those SDKs send. |
| switch-dashboard | `parse ^2.17.0` | Oldest SDK in active use. |
| switch-ops, switch-finance | `parse ^8.6.0` | |

---

## 2. Error strings clients match on

Thrown as `throw CLOUD_ERRORS.X` → `code 141, error: 'X'`. **Spelling is contract**
(`ORDER_FULLFILLED`, `USER_DOES_NOT_EXISTS`, `deletelists` are misspelled on purpose — keep them).

| Error string | Matched by (grep of client source) |
|---|---|
| `USER_UNAUTHORIZED` | food, driver, manager, dashboard, ops |
| `ORDER_CANCELED` | driver, manager, dashboard, ops |
| `ORDER_FULLFILLED` | driver, manager, dashboard, ops |
| `DRIVER_DISCONNECTED` | dashboard, ops |
| `USER_DOES_NOT_EXISTS` | dashboard, ops |
| `USER_PUSH_TOKEN_MISSING` | dashboard, ops |
| `PROMO_EXISTS` | manager, dashboard |
| `EMAIL_MISSING` | food, driver, manager |
| `PHONE_NUMBER_USED` | food, driver, manager (the server check is commented out; clients still branch on it) |
| `FAILED_TO_PROCESS_PAYMENT` | food |
| `PARAMS_MISSING` / `MISSING_PARAMS` | both spellings exist on the server; many client call sites |
| `ACCOUNT_INACTIVE` | clients treat **any** `141` on login as "inactive" unless the message is `EMAIL_MISSING` |

Full legacy list (`cloud/main.js` `CLOUD_ERRORS`, copy verbatim):
`USER_UNAUTHENTICATED, USER_UNAUTHORIZED, FILE_NAME_MISSING, PARAMS_MISSING,
SEND_PUSH_NOTIFICATION_PARAMS_MISSING, PROCESS_PAYMENT_PARAMS_MISSING, SAVE_PAYMENT_PARAMS_MISSING,
LOGIN_WITH_GOOGLE_PARAMS_MISSING, LOGIN_WITH_FACEBOOK_PARAMS_MISSING, LOGIN_WITH_APPLE_PARAMS_MISSING,
VERIFY_PHONE_PARAMS_MISSING, VERIFY_PHONE_ERROR, DRIVER_RATING_PARAMS_MISSING,
LOGIN_STAFF_PARAMS_MISSING, USER_DOES_NOT_EXISTS, ACCOUNT_INACTIVE, PROMO_EXISTS, MISSING_PARAMS,
USER_PUSH_TOKEN_MISSING, STORE_DISABLED, DRIVER_DISABLED, FAILED_TO_PROCESS_PAYMENT, ORDER_CANCELED,
ORDER_FULLFILLED, DRIVER_DISCONNECTED, EMAIL_MISSING, PHONE_NUMBER_USED, DISTANCE_ERROR`.

Parse's own codes that clients branch on: `100` (connection), `101` (invalid login / object not
found), `119` (operation forbidden, e.g. `addField`), `141` (cloud error), `202`/`203` (username /
email taken), `209` (invalid session token). These come from Parse Server itself; v2 keeps them by
keeping Parse Server.

---

## 3. Cloud functions (50)

Guard legend:
- **—** no authentication check.
- **U** `if (!req.user) throw USER_UNAUTHENTICATED`.
- **S** U, then `new Parse.Query(Parse.Role).equalTo('users', req.user).first({useMasterKey})`; no
  row → `USER_UNAUTHORIZED`. **Any** role passes (in practice the only role is `Staff`).

"Returns `1`" means `{ "result": 1 }`. Every DB access in cloud code uses the master key.
"(nw)" = the promise is **not awaited** in legacy (fire-and-forget). v2 keeps it non-blocking and
adds a `.catch(log)` — see plan §9 D-4.

### 3.1 Customer, driver and manager apps

| # | Function | Guard | Required params (else error) | Returns | Side effects (in order) | Callers |
|---|---|---|---|---|---|---|
| 1 | `loginWithGoogle` | — | `idToken, clientUser, language, appType` (else `LOGIN_WITH_GOOGLE_PARAMS_MISSING`); `clientUser.email` (else `EMAIL_MISSING`) | `{newUser:false, sessionToken}` / `{newUser:true, sessionToken}` / `{invalidUser:true}` when `noNewUser` and no account | Find `_User` by `email`. Existing & `!enabled` → `ACCOUNT_INACTIVE`. Existing → `linkWith('google', {authData:{id: clientUser.id, id_token: idToken, photo: clientUser.photo}})`. New → `signUp` with **new-user defaults** (§3.4), username = email local-part, random 8-char password, then `linkWith`. | food, driver, manager |
| 2 | `loginWithFacebook` | — | `accessToken, expirationDate, clientUser, language, appType` (else `LOGIN_WITH_FACEBOOK_PARAMS_MISSING`); `clientUser.email` | same as #1 | As #1 with `authData:{id, access_token, expiration_date, photo: clientUser.picture.data.url}` | **no current source**; keep for old store builds |
| 3 | `loginWithApple` | — | `identityToken, clientUser, language, appType` (else `LOGIN_WITH_APPLE_PARAMS_MISSING`); `clientUser.email` | same as #1 | As #1 with `authData:{id: clientUser.id, token: identityToken}`; `fullname = clientUser.fullName \|\| username` | food, driver, manager |
| 4 | `verifyPhone` | — | `phoneNumber, appType` (else `VERIFY_PHONE_PARAMS_MISSING`) | `{code}` (the OTP itself) | 4-char code from `Math.random().toString().slice(-4)`. POST `application/x-www-form-urlencoded` to `configs.sms.endpoint`: `function=sms_send, apikey, userkey, to=phoneNumber, message = sms.message.replace('%CODE%', code) + '\n' + sms.smsRetrieverHash[appType]`. Response JSON `status !== 'success'` → `VERIFY_PHONE_ERROR`. | food, driver, manager |
| 5 | `calculateOrder` | U | `from, to, city, appType` (else `MISSING_PARAMS`) | `{distance, duration, delivery}` | Google Distance Matrix GET `https://maps.googleapis.com/maps/api/distancematrix/json` with `origins=lat,lng`, `destinations=lat,lng`, `mode=driving`, `units=metric`, `language=en`, `key`. Non-`OK` → `DISTANCE_ERROR`. `distance = parseFloat(rows[0].elements[0].distance.text)`. Reads Config `tripDuration`. Fee rounding and `city.fees[appType]` tiers exactly as legacy (§7 Q-6). | food |
| 6 | `placeOrder` | U | `userId, restaurantId, userAddressId, foodIds, deliveryType, type, options`, and `distance`/`duration` not `undefined` (else `MISSING_PARAMS`) | `1` | 1) if `cardPayment`: Stripe charge (`processPayment`) — **any** failure → `FAILED_TO_PROCESS_PAYMENT`; with legacy's blank Stripe key it always fails, before any write (v2: no Stripe, same answer — D-12). 2) load store (+manager); `!enabled` → `STORE_DISABLED`. 3) create `Order` `{user, restaurant, userAddress, food[], deliveryType, type, options, distance, duration, status:0, isReady:false, canceled:false, driverRated:false, city: store.city, promo?}`. 4) `store.ordersTotal = ordersTotal + 1` (read-modify-write). 5) push manager (§5 P-newOrder). 6) push staff when `sendManagerNotifs` or no manager token (§5 P-staff). | food |
| 7 | `cancelFood` | U | `objectId` | `1` | `status > 0` → `USER_UNAUTHORIZED`. `canceled = true`. Push manager `canceledTo` if store enabled + token. Staff push rule as #6. **No ownership check** (Q-3). | food |
| 8 | `orderRated` | U | `objectId` | `1` | `order.driverRated = true` | food |
| 9 | `savePayment` | U | `tokenId` (else `SAVE_PAYMENT_PARAMS_MISSING`) | `{stripeSourceId, stripeCustomerId}` (never in practice) | Stripe: create customer `{email, name: fullname}` if `payment.stripeCustomerId` missing, else retrieve; `customers.createSource(id, {source: tokenId})`; new customer → `default_source` = new source. Does **not** write the user row. With legacy's blank Stripe key this always fails (141). v2 has no Stripe: `FAILED_TO_PROCESS_PAYMENT` after the same checks (D-12). | food (card screen unreachable: cash only) |
| 10 | `acceptManager` | U | `objectId` | `1` | Missing/canceled → `ORDER_CANCELED`; `status > 0` → `ORDER_FULLFILLED`. `status = 1`; `store.ordersAccepted + 1`. Push customer `confirmed` (§5). If `deliveryType === 'delivery' && !noChoose` → `chooseDriver({objectId})` (nw) — **starts automatic dispatch** (§4). | manager (no `noChoose`), dashboard (`noChoose` from a checkbox), ops (`noChoose: true`) |
| 11 | `cancelManager` | U | `objectId` | `1` | `status > 1` → `ORDER_FULLFILLED`. `canceled = true`. Unless `noNotifs`: push customer (`canceledFromManager` + store name, body = reason); if `reason` and a driver → push driver. Staff push if `!fromAdmin && (reason \|\| sendManagerNotifs)`. | manager, dashboard, ops |
| 12 | `finishManager` | U | `objectId` | `1` | Missing/canceled → `ORDER_CANCELED`. `isReady = true`; pickup → also `status = 2` + push customer `prepared`. | manager, dashboard |
| 13 | `confirmManager` | U | `objectId` | `1` | Missing/canceled → `ORDER_CANCELED`. Pickup only: `status = 3`. | manager, dashboard |
| 14 | `uniquePromo` | U | `code` | `1` | `Promo` with that `code` exists → `PROMO_EXISTS` | manager, dashboard |
| 15 | `acceptDriver` | U | `objectId` | `1` | Missing/canceled → `ORDER_CANCELED`. No driver or same driver → `order.driver = req.user`, then `agenda.cancel({'data.objectId': objectId})`. Else `ORDER_FULLFILLED`. Legacy reads then writes, so drivers accepting at once all get `1`; **v2: one atomic claim, exactly one wins (D-20).** | driver |
| 16 | `checkDriver` | U | `objectId` | `1` | Missing/canceled → `ORDER_CANCELED`. Driver is caller → `driverOrdersAccepted + 1`, return `1`. Else `ORDER_FULLFILLED`. | driver |
| 17 | `cancelDriver` | U | `objectId` | nothing — the function returns `undefined`, so the body is `{}` and the SDK resolves `undefined`. v2 must not return `1` here. | `order.driver = null`. **With** `reason` (truthy): staff push `canceledFromDriver … Reason: …`. **Without** (incl. `''`): `chooseDriver({objectId, driverId: caller})` (nw). Legacy does this for any caller; **v2 only for the driver holding the order, anyone else gets `{}` and nothing happens (D-20).** | driver |
| 18 | `toDestinationDriver` | U | `objectId` | `1` | `status = 2`; push customer `onTheWay` with `button: trackOrder`, `screen: 'TrackOrder'`, `driverId`. | driver |
| 19 | `arrivedDriver` | U | `objectId` | `1` | Push customer `arrived` (`screen: 'OrderDetails'`). No DB write. | driver |
| 20 | `finishDriver` | U | `objectId` | `1` | `status = 3`; data-only push to customer `{rate:"true", orderId, id: driverId, restaurantId}`. | driver |
| 21 | `deleteFile` | U | `filename` (else `FILE_NAME_MISSING`) | `1` | Role looked up but **not required**. Allowed if `FileObject` row exists and (caller has any role **or** is `createdBy`), else `USER_UNAUTHORIZED`. Destroys the `FileObject` row, then deletes the stored file (legacy: un-awaited HTTP `DELETE {publicServerURL}/files/<name>` with the master key — see plan §6.4). | all apps + dashboard + ops |

### 3.2 Staff (switch-dashboard, switch-ops)

| # | Function | Guard | Required params | Returns | Side effects | Callers |
|---|---|---|---|---|---|---|
| 22 | `loginStaff` | — | `username, password` (else `LOGIN_STAFF_PARAMS_MISSING`) | `{sessionToken}` | If `_User` count > 0: user by `username` (none → `USER_DOES_NOT_EXISTS`); no role → `USER_UNAUTHORIZED`; `Parse.User.logIn(username, password)` (so `beforeLogin` runs; bad password → Parse `101`). If the DB has **zero users**: bootstrap — saves default Config (§6), creates admin user (`staffType: 'Admin'`, `appType: ['staff']`, email = `configs.admin.emailAddress`), creates role `Staff` (nw), logs in. | dashboard, ops |
| 23 | `updateConfigs` | S | `configs` (else `PARAMS_MISSING`) | `1` | `Parse.Config.save(configs, {useMasterKey:true})` — the second argument is the SDK's **masterKeyOnly flags**, so legacy also writes `masterKeyOnly.useMasterKey = true` into `_GlobalConfig` (Q-9). | dashboard |
| 24 | `getUsers` | S | `limit`, `skip` not `undefined` | `{count, results: user.toJSON()[]}` | `_User` query, `descending('createdAt')`, `include city, address, managerStore`; filters `appType` (equalTo), `disabled` → `enabled=false`, `driverActive` → `true`, `cityId` → city pointer; `limit`/`skip`; `search {key, value}` → `fullText` or `startsWith`; `withCount()`. Master key → full rows. | dashboard, ops |
| 25 | `addUser` | S | `fullname, username, password, email, appType, cityId`, `enabled !== undefined` | `1` | `signUp` with new-user defaults (§3.4) but `language:'en'`, given `phone`, `city`, `enabled`, `staffType`. `staffType` → add to role `Staff` (nw). Verification email is sent (`verifyUserEmails: true`). | dashboard, ops |
| 26 | `editUser` | S | `id, fullname, email, phone, appType, cityId` | `1` | Sets `fullname, phone, appType, city, staffType`. An omitted `staffType` is sent as `set('staffType', undefined)`, which the SDK drops from the request body, so the field is **left alone**, not cleared (corrected 2026-09-21 from reading SDK 2.15; to be confirmed by a parity scenario against legacy). The ops console resends it anyway, which is safe either way, `email` only if changed, `password` if given. `staffType` → add to `Staff` (nw). Never removes from the role. | dashboard, ops |
| 27 | `deleteUsers` | S | `ids` | `1` | Per user: destroy user → delete picture file → destroy sessions → food: destroy addresses → manager: destroy store, its picture, lists (cascades via `afterDelete List`), promos, reviews (+pictures) → driver: destroy driver reviews. | dashboard, ops |
| 28 | `toggleEnableUsers` | S | `ids` | `1` | Flip `enabled`; disabling also sets `driverActive=false`; manager: store `enabled` + all store `Food.enabled` (not `List`). | dashboard, ops |
| 29 | `deleteMessages` | S | `ids` | `1` | Destroy `Message` rows. | dashboard, ops |
| 30 | `editPromo` | S | `id` (the `Object.keys(...) <= 1` check never fires — Q-1) | `1` | Clears `city, restaurant, food`; then `cityId/restaurantId/foodId` → pointers, `expirationDate` → `Date`, any other key except `id`, `code` → set. | dashboard |
| 31 | `assignPromo` | S | `id, restaurantId` | `1` | If the store has a manager: promo ACL = public read + manager write. | dashboard |
| 32 | `deletePromos` | S | `ids` | `1` | Destroy (runs `afterDelete Promo`). | dashboard |
| 33 | `deleteStores` | S | `ids` | `1` | Per store: destroy store → picture → manager user (+picture, sessions, addresses, driver reviews) → lists (cascade) → promos → reviews (+pictures). | dashboard, ops |
| 34 | `toggleEnableStores` | S | `ids` | `1` | Flip store `enabled`; manager `enabled` (+`driverActive=false` when disabling); all `List.enabled`; all `Food.enabled`. | dashboard, ops |
| 35 | `assignManager` | S | `storeId` | `1` | Old manager: `managerStore=null`, remove `'manager'` from `appType`. No `managerId` → `store.manager=null`, return. Else: `store.manager`, store ACL = public read + manager write + role `Staff` write; manager `managerStore`, `appType += 'manager'`; `FileObject.createdBy` for store picture, lists ACL, food ACL + picture owner, promos ACL (these without the Staff role grant). | dashboard, ops |
| 36 | `assignStoreFile` | S | `filename, storeId` | `1` | `FileObject(fileName).createdBy = store manager` | dashboard, ops |
| 37 | `changeRegion` | S | `storeId, cityId` | `1` | `store.city` and every store `Food.city` | dashboard, ops |
| 38 | `editList` | S | `id` | `1` | Sets every other param as a field (mass assignment — Q-2). | dashboard, ops |
| 39 | `assignList` | S | `id, restaurantId` | `1` | List ACL = public read + manager write (if a manager exists). | dashboard, ops |
| 40 | `deletelists` | S | `ids` | `1` | Destroy lists (cascade deletes their `Food` and pictures). **Lower-case `l` in the name.** | dashboard, ops |
| 41 | `editProduct` | S | `id` | `1` | Sets every other param (runs `afterSave Food`). | dashboard, ops |
| 42 | `assignProduct` | S | `id, restaurantId` | `1` | Food ACL + picture `FileObject.createdBy` (if a manager exists). | dashboard, ops |
| 43 | `deleteProducts` | S | `ids` | `1` | Destroy + delete picture file. | dashboard, ops |
| 44 | `duplicateProduct` | S | `id` | `1` | New `Food` from `toJSON()` minus `objectId`, `picture` (ACL copied; `createdAt/updatedAt` silently ignored by the SDK). | dashboard, ops |
| 45 | `deleteReviews` | S | `ids` | `1` | Destroy + delete picture file. | dashboard |
| 46 | `deleteOrders` | S | `ids` | `1` | Destroy orders. | dashboard |
| 47 | `editOrder` | S | `id` | `1` | If found: `status`, `canceled` when defined; `options` shallow-merged; `foodIds` → pointer array. | dashboard, ops |
| 48 | `assignDriver` | S | `orderId, driverId` | `1` | Driver missing / `!enabled` / `!driverActive` → `DRIVER_DISCONNECTED`. `order.canceled=false`, `order.driver=null`. Notify driver: FCM `newOrder`, plus Pusher when Config `driverRealtime` (§5, D-19). | dashboard, ops (+ ops queue runner) |
| 49 | `chooseDriver` | S | `orderId` | `1` | `canceled=false`, `driver=null`, start automatic dispatch (nw). | dashboard |
| 50 | `sendPush` | S | — (`SEND_PUSH_NOTIFICATION_PARAMS_MISSING` from the sender if no title+data or no target) | `1` | `userId+appType` → that user's `pushToken[appType]` (missing user → `USER_DOES_NOT_EXISTS`, no token → `USER_PUSH_TOKEN_MISSING`); `cityId+appType` → FCM condition `'<appType>' in topics && '<cityId>' in topics`; `appType` → topic. Title, body, data, imageUrl passed through. | dashboard, ops |

**Called by clients, missing from legacy, added in v2** (D-22): `setOpsAccess` (switch-ops) and
`setFinanceAccess` (switch-finance), with the `beforeSave _User` guard behind them. Specs:
`switch-ops/docs/ops-access-backend.md`, `switch-finance/docs/finance-access-backend.md`. Legacy
answers both with `141 Invalid function`, which the consoles show as "not deployed yet".

**Added in v2 for driver declines** (D-23): `declineDriver({ objectId })` (driver app, U, answers
`{}`) stores `Order.driverDeclines.<driverId>` and sends Pusher `driverDeclined` to ops;
`authorizeOpsChannel({ socketId, channelName })` (switch-ops) signs its private Pusher channels
(`private-ops`, `private-ops-city-<cityId>`). `assignDriver` unsets the assigned driver's key in `driverDeclines`.

**Added in v2 for switch-admin** (D-24): guard **A** — guard S, then the caller's current row
must be an enabled admin, else `141 ADMIN_REQUIRED`. It now also applies to `updateConfigs`
(always), `addUser` (creating a staff account), `editUser` (a staff-tagged target, a `staffType`
change, or staff/admin added to `appType`) and `deleteUsers` / `toggleEnableUsers` (any
staff-tagged target in the batch). New functions, all guard A:

| Function | Params | Returns | Effect |
|---|---|---|---|
| `signOutStaff` | `userId` | `{ objectId, sessions }` | Destroys every `_Session` of a staff-tagged account. |
| `removeStaff` | `userId` | `{ objectId, sessions }` | Removes it from role `Staff`, unsets `staffType`, `opsAccess`, `financeAccess`, drops staff/admin from `appType`, destroys its sessions. The account stays. |
| `recountRatings` | `restaurantIds?`, `driverIds?` (≤100 in all) | `{ restaurants, drivers }` | Recounts rating totals from the `Review` rows left (after `deleteReviews`). |

Refusals: `PARAMS_MISSING`, `SELF_NOT_ALLOWED` (the caller as target), `NOT_STAFF_ACCOUNT`,
`USER_DOES_NOT_EXISTS`.

### 3.3 Triggers (11)

| Trigger | Legacy behaviour |
|---|---|
| `beforeLogin` | `!user.enabled` → throw `ACCOUNT_INACTIVE` (clients get `141`). Applies to `/login` (finance, apps' username login) and to `Parse.User.logIn` inside `loginStaff`. |
| `afterLogout` | `session.user.driverActive = false`, saved with the master key (nw). |
| `beforeSaveFile` | No `req.user` → throw `USER_UNAUTHENTICATED`. |
| `afterSaveFile` | Create `FileObject {fileName: file.name(), file, createdBy: user}`. |
| `afterSave Food` | `isDiscount` → store `isDiscount = true`; else if no other discounted food in the store → `false`. |
| `afterDelete Food` | Same recount as above. |
| `afterDelete List` | Destroy every `Food` with that `list`, deleting each picture file. |
| `afterSave Promo` | Has `restaurant` → store `isPromo = true`. |
| `afterDelete Promo` | No remaining **unexpired** promo for that store → `isPromo = false`. |
| `afterSave Message` | Staff push `newMessage` (§5). Reads `req.user.get('city')` first, so a master-key save throws before doing anything (swallowed by Parse — Q-8). |
| `afterSave Review` | Copy `req.user.city` onto the review (re-saves it); then add `rating` to the store's (`ratingTotal`, `reviews`, `rating` rounded to 1 decimal) or the driver's (`driverParams.{ratingTotal, reviews}`, `driverRating`) totals, only if that store/driver is `enabled`. Runs on **every** save with a user, including edits (Q-8). |

`afterSave`/`afterDelete` errors are logged and swallowed by Parse Server in both 4.3
(`RestWrite.js` "afterSave caught an error") and 9.x, and the trigger is awaited before the
response. v2 relies on this and must not change it.

### 3.4 New-user defaults (written by `loginWith*`, `addUser`, `loginStaff` bootstrap)

`language, appType, enabled: true, pushToken: {}, theme: 'light', promoNotifs: true,
payment: {method:'cash', stripeCustomerId:null, stripeDefaultSourceId:null, list:[]},
cartOptions: {}, cartFood: [], favorites: [], promosUsed: [], driverActive: false, driverRating: 0,
driverOrdersAccepted: 0, driverParams: {ratingTotal:0, reviews:0}` and `undefined` for `phone,
picture, address, city, managerStore, driverLocation, staffType` (overridden per function as in
§3.1/§3.2). This object is one constant in v2 (`domain/users/defaults.ts`), unit-tested against
the legacy literal.

---

## 4. Automatic dispatch job (`chooseDriver`, Agenda)

Although ops dispatch by hand, the legacy server **still starts automatic dispatch** in three
places: `acceptManager` without `noChoose` (**the manager app always omits it**), `cancelDriver`
without a reason, and the dashboard's "Choose Driver". It is live production behaviour, so v2
keeps it byte-for-byte. Changing it is a product decision (plan §12, open decision OD-2).

- Collection `agendaJobs` on the Parse database. Agenda 4.1.3 defaults: poll every **5 s**,
  lock lifetime **10 min**. Every App Engine instance runs a worker (`agenda.start()` at module
  load).
- Start: `agenda.create('chooseDriver', {objectId, iteration: 0, calledDriver})`,
  `job.unique({'data.objectId': objectId})`, `job.run()` (in-process, not awaited), `job.save()`.
  In 4.1.3 `run()` saves first (with `nextRunAt` computed to empty for a one-off job), so
  **orphan rows with `nextRunAt: null` are expected** in production. They are never picked up
  (`nextRunAt <= now` doesn't match null). v2 must not run them either (test J-5).
- Handler: remove the job; reload the order (+user, +restaurant). Stop if the order has a driver
  or is canceled. Search radius `1 + iteration` km, capped below **6 km**; query `_User` with
  `appType='driver', enabled, driverActive, withinKilometers('driverLocation', restaurant.location,
  r, true)`, `descending('driverRating')`, excluding `calledDriver`; widen until found or cap.
  Notify **every** driver found (FCM `newOrder`, plus Pusher when Config `driverRealtime` — D-19).
  v2 skips a driver already sent the order during this offer, by the search or by ops (D-21).
  Re-schedule in **2 minutes** with the new iteration (`lastRun` gives one extra empty round).
  When the search is exhausted: if Config `noDriverHandleAdmin` is false → set `canceled = true`,
  push customer and manager `canceledNoDriver`; always push staff (`noDriverActionRequired` or the
  first clause of `canceledNoDriver`). v2 cancels only while the order still has no driver: if one
  accepted since the round read the order, the round stops there with no pushes at all (D-20).
- `acceptDriver` cancels with `agenda.cancel({'data.objectId': objectId})` — a raw MongoDB
  `deleteMany` on a **partial** data match.

---

## 5. Outbound payloads (what phones and dashboards receive)

All FCM sends go through `admin.messaging().send(message)` (FCM HTTP v1) with
`android: {priority: 'high'}`, `notification: {title, body?, imageUrl?}` only when there is a
title, `data` as given, and exactly one of `token` / `topic` / `condition`. Send errors are
swallowed. **All `data` values are strings.** Titles come from
`cloud/localization/translations.json` (`en`, `fr`, `ar` — copy byte-for-byte, including the
existing typo `طلب جدبد`), with `%s` → `#<orderId>`, fallback language `en`.

| Id | To (token slot) | title | data |
|---|---|---|---|
| P-newOrder | manager (`pushToken.manager`), driver (`pushToken.driver`) | `newOrder + ' #' + id` | `{id, newOrder:"true", launchApp:"true", playSound:"true"}`. v2, driver only: also `android.notification.tag` and `apns-collapse-id` = id (D-21) |
| P-staff | every `appType='staff'` user in the order user's (or caller's) `city` — or all staff when Config `sendNotifsToAll` | varies | `{notifId: <8 random digits>, id, page: 'orders' \| 'support'}` |
| P-confirmed | customer (`pushToken.food`) | `confirmed + ' ' + store.name` | `{id, icon:'success', button: viewOrder, screen:'OrderDetails'}` |
| P-prepared | customer | `prepared` | `{id, icon:'prepared', button, screen:'OrderDetails'}` |
| P-onTheWay | customer | `onTheWay` | `{id, icon:'onTheWay', button: trackOrder, screen:'TrackOrder', driverId}` |
| P-arrived | customer | `arrived` | `{id, icon:'arrived', button: viewOrder, screen:'OrderDetails'}` |
| P-rate | customer | *(none — data only)* | `{rate:"true", orderId, id: driverId, restaurantId}` |
| P-cancel | customer / manager / driver | `canceledTo`, `canceledFromManager + ' ' + store.name`, `canceledNoDriver`; `cancelManager` adds `body = translations.reason + ': ' + <reason>` when a reason is given | `{id, cancel:"true", icon:'error'}` |
| P-sendPush | anyone (staff-chosen) | staff-chosen | staff-chosen — **must be forwarded untouched** (see the `icon` contract in switch-ops notes: an unknown `data.icon` crashes installed app builds) |

**Pusher:** `pusher.trigger(<driver objectId>, 'orderEvent', {data: {id: orderId}})`, TLS, cluster
from config. switch-driver subscribes to its own `objectId` channel and binds `orderEvent`.
Since D-19 every Pusher trigger is paired with the driver's FCM `newOrder` (legacy sent Pusher
only), which still reaches a driver whose app process is gone.

**SMS:** §3.1 #4. **Email:** Parse Server's own verification and password-reset emails
(`verifyUserEmails: true`, token valid 48 h; reset token valid 2 h), sent from
`no-reply@switchfood.net` via SendGrid (legacy adapter uses SendGrid's old v2 `mail.send.json`
Web API).

**Files:** DigitalOcean Spaces bucket `switchfood` (fra1), `directAccess: true`,
`baseUrl https://switchfood.fra1.cdn.digitaloceanspaces.com`, `Cache-Control: public,
max-age=31536000`, uploaded with `ACL: public-read`. The URL a client sees is
`<baseUrl>/<each path segment encodeURIComponent'd>` (legacy `@parse/s3-files-adapter` 1.4.0
`getFileLocation`). Stored rows hold only the file **name**, so the URL is recomputed on every
read — v2's adapter must produce the identical string (test F-1).

---

## 6. Parse Config keys (read by server or clients)

Server reads: `tripDuration {preparationTime, timePerKm}`, `driverRealtime`,
`noDriverHandleAdmin`, `sendNotifsToAll`, `sendManagerNotifs`.
Clients read (server must not remove or rename): `supportNumbers`, `storeUrls`, `pickupEnabled`,
`homeSections`, `cartFloatButton`, `showSmsHashButton`, `supplementsAutoComplete`, plus the above.
Values live in `_GlobalConfig` in the database — **v2 never writes Config at boot.**

---

## 7. Classes the clients read/write directly (server-side contract = schema + CLP + triggers)

`_User, Order, Restaurant, City, Address, Promo, Food, List, Review, Ad, Category, Message,
Notification, FileObject, DispatchQueue` (DispatchQueue is ops/driver-only, created by hand in the
Parse Dashboard). The repo's `_SCHEMA.json` is a **2023 snapshot** and is out of date (it lacks
`DispatchQueue`, `_User.opsAccess`/`financeAccess`, `Order.opsCustomerCall`/`opsRestaurantCall`).
Schema, CLPs and indexes are owned by the Parse Dashboard / Atlas — **v2 must not create, alter
or delete any of them at boot** (plan §6.2 lists the few indexes Parse Server itself creates, and
how they're handled).

Relied-upon ACL shape: `_User` rows are `{"*":{"read":true},"<ownId>":{"read":true,"write":true}}`
(switch-finance depends on public read), which is why `enforcePrivateUsers` must be `false`.

---

## 8. Legacy quirks that are part of the contract (port them as-is; fix later, one by one)

| Id | Quirk | Why it stays in the cutover release |
|---|---|---|
| Q-1 | `Object.keys(req.params) <= 1` compares an array to a number and is never true; only `id` is actually required in `editList/editProduct/editPromo`. | A stricter check could reject a payload a client sends today. |
| Q-2 | `editList`/`editProduct` set **any** key the caller sends, with the master key. | ops and dashboard send varying field sets. Allow-listing needs a client payload audit first (Phase 6). |
| Q-3 | Order functions check authentication but **not** ownership or role (e.g. any signed-in user can call `cancelFood`/`acceptManager` on any order). | Adding checks without auditing every caller risks locking out ops/dashboard flows. Phase 6, per function. |
| Q-4 | `verifyPhone` is unauthenticated and returns the OTP to the client, which verifies it on-device. | Apps depend on getting `{code}` back. Fixing needs new app builds. |
| Q-5 | `sendPush` builds the FCM condition by string interpolation. | Same payloads as today. |
| Q-6 | `calculateOrder` parses the **display text** of the distance (`"12.3 km"` → 12.3). Google shows short distances in metres (`"950 m"`), which would parse as 950 (read as km). | Changing the fee maths changes prices. Product decision (OD-3). |
| Q-7 | ~~`placeOrder` charges the card **before** checking the store is enabled.~~ | Moot: cards are unused and v2 removed Stripe (OD-4, D-12). A `cardPayment` is still refused before any write, as legacy. |
| Q-8 | `afterSave Message/Review` begin with `req.user.get(...)`: a master-key save throws, and Parse swallows it. `afterSave Review` also adds the rating again on every edit. | Ported as an explicit early return with the same effect (it does nothing). Behaviour is the same. |
| Q-9 | `updateConfigs` writes a stray `masterKeyOnly.useMasterKey = true` into `_GlobalConfig`. | Harmless. It keeps the DB-diff parity tests exact. |
| Q-10 | Counters (`ordersTotal`, `ordersAccepted`, `driverOrdersAccepted`, ratings) are read-modify-write, not atomic `increment`. | Parity. Phase 6 (atomic increments are safe but still a behaviour change). |
| Q-11 | A user `language` outside `en/fr/ar` makes the push step throw **after** the DB write, so the client sees an error although the order was placed. | Parity. Phase 6 fix = fall back to `en`. |
| Q-12 | Many functions dereference a missing row (`order.set` on `undefined`) and fail with a `TypeError` → `141 <engine message>`. | Same code (141). The **message text** differs between Node 14 and 24 (D-2). No client matches these messages. |
