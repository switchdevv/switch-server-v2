# Local development: the whole platform on your Mac

One command runs switch-server-v2 on Docker with seeded test data, and every app and dashboard
pointed at it. Nothing in this setup can reach production: the server runs with `APP_ENV=local`
(the prod-leak guard refuses production values), pushes, SMS and email are fakes, and each client
only talks to the local server through its own opt-in `:local` script.

## Once

- Docker Desktop running, Node 24, pnpm, and `npm install` done in each client.
- For the phone apps: an Android emulator or device (`adb` on the PATH) or the iOS simulator.

## Every day

```bash
cd switch-server-v2
pnpm dev:all
```

This starts, in order:

| What | Where | Notes |
|---|---|---|
| Mongo (replica set) + S3 (SeaweedFS) | Docker, `27018`, `9000` | `pnpm stack:up`. Data persists between runs. |
| switch-server-v2 | http://localhost:1337 | `pnpm dev` (hot reload). Fake push/SMS/email/Pusher calls are printed in full in its log, including OTP codes and email links. |
| Seed | — | `pnpm seed`: only when the database is empty. |
| switch-finance | http://localhost:3000 | `npm run dev:local` |
| switch-dashboard | http://localhost:3010 | `npm run dev:local` |
| switch-ops | http://localhost:3020 | `npm run dev:local` |
| switch-admin | http://localhost:3030 | `npm run dev:local` |
| switch-food Metro | `:8081` | `npm run start:local` |
| switch-driver Metro | `:8082` | `npm run start:local` |
| switch-manager Metro | `:8083` | `npm run start:local` |

Pick a subset with `pnpm dev:all --only ops,food` or `--skip mobile` (groups: `web`,
`mobile`). Ctrl-C stops everything except Docker; `pnpm stack:down` stops Docker too.

### Phone apps

With Metro running, install each app once from its own folder (another terminal):

```bash
cd switch-driver
npm run android:local
```

`ios:local` builds for the iOS simulator instead. The `:local` builds are wired to their own Metro
port, so all three apps run side by side on one emulator. `android:local` also forwards the
server (`1337`) and S3 (`9000`) ports with `adb reverse`, so `localhost` works on the emulator
and on a USB device.

## Accounts

Every seeded account uses the password `switch-dev` (set `SEED_PASSWORD` before seeding to change
it). Log in with the username:

| Username | Who | Use in |
|---|---|---|
| `admin` | Admin (staff) | dashboard, ops, finance, admin |
| `ops` | Ops staff with ops and finance access | dashboard, ops, finance |
| `manager.roma`, `manager.burger`, `manager.couscous` | Restaurant managers | switch-manager |
| `driver.amine`, `driver.sara`, `driver.yacine` | Online drivers 0.5 / 2 / 4 km from Pizza Roma | switch-driver |
| `customer` | Customer in Alger with a saved address | switch-food |
| `customer.disabled` | Disabled account (login refused) | switch-food |

The seed also creates two cities (Alger with the two-tier delivery table, Oran with the one-tier
one), three restaurants with menus and a discounted dish, a `WELCOME` promo (20%), a support
message from a driver, and 65 orders: 60 spread over the last 30 days (finance, reports) and 5
still open (ops board, dispatch). It applies production's schema and class-level permissions
(`tools/seed/schema.json`, including `DispatchQueue`), so permission bugs show up locally too.

`pnpm db:reset` empties the database and seeds again.

## How each client switches to local

Each client has one extra script. Its existing scripts and all release builds keep pointing at
production, untouched.

| Client | Script | Mechanism |
|---|---|---|
| switch-ops, switch-finance, switch-admin | `dev:local` | `NEXT_PUBLIC_PARSE_SERVER_URL=http://localhost:1337` overrides `.env.local`; builds into `.next/local` so no production-compiled code is reused. |
| switch-dashboard | `dev:local` | `VITE_PARSE_SERVER_URL`, read only when `import.meta.env.DEV`. |
| switch-food, -driver, -manager | `start:local`, `android:local`, `ios:local` | Metro gets `SWITCH_LOCAL_SERVER_URL`; a Babel step inlines it into `src/configs/index.js`, which uses it only when `__DEV__`. Local mode has its own Metro cache. |

## Things that behave differently locally

- **Google / Apple sign-in** check real tokens with Google and Apple, so they work only with a
  real account and create it in the local database. Use username + password logins instead.
- **Distance Matrix** is faked: every trip is 3.2 km.
- **Pushes** aren't delivered; the server log shows each one it would have sent.
- **Photos** go to the local S3, SeaweedFS (`http://localhost:9000/switchfood-local/...`). It runs
  with no identities, so uploads are signed but unchecked and every file URL is public, as with
  Spaces in production. It replaced MinIO, whose community edition was archived and whose images
  were removed from Docker Hub.
- **Location**: the customer app finds its city from the address pin, so drop pins inside Alger
  (around 36.75, 3.06) or Oran (around 35.70, -0.63). Set the emulator's location there to see
  the drivers on the map.

## Troubleshooting

- *Port … is taken*: `dev:all` refuses to start over another process. `lsof -i :<port>` shows it.
- *Mongo connection timeouts*: the URI must keep `?directConnection=true` (see `.env.example`).
- *A phone app shows production data, or loads another app's bundle*: it was installed with
  `npm run android` / `ios`, which expects Metro on 8081 (switch-food's local Metro, or a
  production `npm start`). Reinstall it with `npm run android:local` / `ios:local`.
