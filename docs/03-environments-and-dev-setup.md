# switch-server v2 — Environments, `.env` files, secrets and local development

Companion to [01-rewrite-plan.md](01-rewrite-plan.md). This is the target design. Nothing here
exists yet.

---

## 1. Environments

| `APP_ENV` | Where it runs | Database | Outbound services | Secrets from |
|---|---|---|---|---|
| `local` | your laptop (`pnpm dev`) | Docker Mongo `localhost:27018`, db `switch_local` | **fakes** (recorded in the server log; files go to the local SeaweedFS S3). Real drivers are refused. | `.env.local` (generated, fake values only) |
| `test` | vitest / CI | mongodb-memory-server, or the CI Mongo service | fakes only | `.env.test` (committed, fake) |
| `staging` | App Engine, **separate project** (OD-1) | separate Atlas cluster | real providers on **staging accounts**, each behind an allowlist (email recipients, SMS numbers, push tokens) | Secret Manager `switch-server-env` in the staging project |
| `rehearsal` | temporary App Engine version or a laptop, against a **restored copy** of prod (Phase 5) | temporary Atlas cluster | **fakes, hard-wired**. No provider credentials are loaded at all. | only `DATABASE_URI`, `PARSE_MASTER_KEY` of the copy |
| `production` | App Engine, `switch-proj` | prod Atlas | real | Secret Manager `switch-server-env` in `switch-proj` |

The **prod-leak guard** (plan §3.5) runs first in every environment except `production`.

---

## 2. The `.env` files

| File | Committed | Contains | Used when |
|---|---|---|---|
| `.env.example` | yes | **Every** variable, each with a comment: what it is, which environments need it, whether it is secret, and its legacy `configs.js` source. No working values. | Documentation; `pnpm setup:env` reads it as the template. |
| `.env.local` | **no** (gitignored) | Local values: Docker URLs, fake drivers, **randomly generated** master/maintenance keys and seed passwords. Never a real third-party credential. The guard rejects prod values. | `APP_ENV=local` |
| `.env.test` | yes | Fixed fake values for deterministic tests. | `APP_ENV=test` |
| `.env.staging` | yes | **Non-secret** staging config: public URL, bucket name, Pusher cluster, allowlists, feature flags, `SECRETS_VERSION`. | `APP_ENV=staging` |
| `.env.prod` | yes | **Non-secret** production config: `https://api.switchfood.net`, bucket `switchfood`, Spaces base URL, Pusher cluster `eu`, `MAIL_FROM`, Google/Facebook/Apple client ids (public by nature), SMS template and retriever hashes, `SECRETS_VERSION`. | `APP_ENV=production` |

**Why `.env.prod` and `.env.staging` are committed:** they hold no secrets, only the reviewed,
versioned description of each environment. A CI check fails the build if any key marked
`secret` in the schema appears in a committed env file (on top of gitleaks). Secrets for staging
and prod live **only** in Secret Manager.

### 2.1 Loading order (`src/config/load.ts`)

1. `APP_ENV` comes from the process environment: App Engine's `env_variables` in `app.yaml` /
   `app.staging.yaml`, or the npm script (`local` by default).
2. `process.loadEnvFile()` loads the matching file (`.env.local`, `.env.test`, `.env.staging`,
   `.env.prod`). Values already in the process environment win. A unit test pins this precedence.
3. `staging`/`production`: fetch **one** Secret Manager secret, `switch-server-env`, at the exact
   version in `SECRETS_VERSION` (never `latest`, so a deploy is reproducible and a rollback also
   rolls back secrets). Merge its JSON keys. In production, boot **refuses** if a secret key
   already came from the plain environment (e.g. someone pasted it into `app.yaml`).
4. Validate everything with the zod schema → a frozen, typed `Config`. Nothing else in `src/`
   reads `process.env` (enforced by an ESLint `no-restricted-properties` rule).
5. Run the prod-leak guard (non-production only).

---

## 3. Variable catalogue

`S` = secret (Secret Manager in staging/prod, generated or fake locally). "Legacy" = where the
value lives in `switch-server/configs.js` today.

### Core

| Variable | S | Local value | Prod source | Legacy |
|---|---|---|---|---|
| `APP_ENV` | | `local` | `app.yaml` | — |
| `PORT` | | `1337` | set by App Engine | `process.env.PORT \|\| 80` |
| `LOG_LEVEL` | | `debug` | `.env.prod` (`info`) | — |
| `PARSE_APP_NAME` | | `Switch` | `.env.prod` | `parse.appName` |
| `PARSE_APP_ID` | | the **same app id as prod** (it is public, compiled into every client), so local clients only need a URL change | `.env.prod` | `parse.appId` |
| `PARSE_MASTER_KEY` | S | random | Secret Manager | `parse.masterKey` |
| `PARSE_MAINTENANCE_KEY` | S | random | Secret Manager | *(new in Parse 6)* |
| `DATABASE_URI` | S | `mongodb://localhost:27018/switch_local?directConnection=true` (the single-node set advertises `localhost:27017`, its in-container address; host port 27017 is `dzdash-mongo`) | Secret Manager | `parse.databaseURI` |
| `PARSE_PUBLIC_SERVER_URL` | | `http://localhost:1337` | `.env.prod`: `https://api.switchfood.net` | `parse.publicServerURL` |
| `PARSE_SERVER_URL` | | defaults to `http://localhost:${PORT}` | same default | *(legacy used the public URL)* |
| `MASTER_KEY_IPS` | | `0.0.0.0/0,::/0` (**allowed only in local/test**) | `.env.prod` (OD-6) | *(any IP)* |
| `TRUST_PROXY` | | unset | `.env.prod`, measured in P4-3 | — |
| `CLIENT_IP_HEADER` | | unset | `x-appengine-user-ip` in `.env.staging` and `.env.prod` (required in staging) | — |
| `DB_MAX_POOL_SIZE`, `DB_MAX_TIME_MS`, `DB_SERVER_SELECTION_TIMEOUT_MS` | | driver defaults | `.env.prod`, from rehearsal | — |

### Auth adapters (public identifiers, not secrets)

| Variable | Value | Legacy |
|---|---|---|
| `GOOGLE_CLIENT_ID` | same as the apps' `webClientID` (verified identical in all three apps) | `google.clientID` |
| `FACEBOOK_APP_IDS` | comma-separated | `facebook.appId` |
| `APPLE_CLIENT_IDS` | `com.switchapp.food,com.switchapp.driver,com.switchapp.manager` | *(none: legacy didn't check the audience)* |

### Outbound services

Each has a `*_DRIVER` switch: `fake` (records, never sends), `allowlist` (real, but only to listed
recipients; staging), or the real driver (production).

| Variable | S | Notes | Legacy |
|---|---|---|---|
| `MAIL_DRIVER` | | `smtp` locally (→ Mailpit), `allowlist`/`sendgrid` | — |
| `MAIL_FROM` | | `no-reply@switchfood.net` | `sendgrid.fromAddress` |
| `SMTP_URL` | | `smtp://localhost:1025` (local only) | — |
| `SENDGRID_API_KEY` | S | | `sendgrid.apiKey` |
| `MAIL_ALLOWLIST` | | staging recipients | — |
| `PUSH_DRIVER` | | `fake` / `allowlist` / `fcm` | — |
| `FIREBASE_SERVICE_ACCOUNT` | S | the service-account JSON as one string | `firebase` |
| `PUSH_TOKEN_ALLOWLIST` | | staging device tokens (OD-7) | — |
| `REALTIME_DRIVER` | | `fake` / `pusher` | — |
| `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_CLUSTER` | | non-secret identifiers (the driver app ships the key) | `pusher.*` |
| `PUSHER_SECRET` | S | | `pusher.secret` |
| `SMS_DRIVER` | | `fake` / `allowlist` / `sms-algerie` | — |
| `SMS_ENDPOINT` | | provider URL | `sms.endpoint` |
| `SMS_API_KEY`, `SMS_USER_KEY` | S | | `sms.apiKey`, `sms.userKey` |
| `SMS_MESSAGE_TEMPLATE` | | `Your Switch code is: %CODE%` | `sms.message` |
| `SMS_RETRIEVER_HASH_FOOD` / `_DRIVER` / `_MANAGER` | | Android SMS Retriever app hashes (not secret) | `sms.smsRetrieverHash` |
| `SMS_PHONE_ALLOWLIST` | | staging numbers | — |
| `DISTANCE_DRIVER` | | `fake` / `google` | — |
| `GOOGLE_MAPS_API_KEY` | S | | `google.mapKey` |

### Files (always the S3 adapter: SeaweedFS locally, Spaces in staging/prod)

| Variable | S | Local | Prod | Legacy |
|---|---|---|---|---|
| `S3_BUCKET` | | `switchfood-local` | `switchfood` | `spaces.bucket` |
| `S3_BASE_URL` | | `http://localhost:9000/switchfood-local` | `https://switchfood.fra1.cdn.digitaloceanspaces.com` | `spaces.baseUrl` |
| `S3_ENDPOINT` | | `http://localhost:9000` | `https://fra1.digitaloceanspaces.com` | `spaces.s3overrides.endpoint` |
| `S3_REGION` | | `us-east-1` | `us-east-1` | — |
| `S3_FORCE_PATH_STYLE` | | `true` (local SeaweedFS) | `false` | — |
| `S3_CACHE_CONTROL` | | `public, max-age=31536000` | same | `spaces.globalCacheControl` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S | any value (the local S3 checks no signatures) | Secret Manager | `spaces.s3overrides.*` |

### Staff bootstrap and dispatch

| Variable | Value | Legacy |
|---|---|---|
| `ADMIN_EMAIL` | `support@switchfood.net` | `admin.emailAddress` |
| `ADMIN_APP_TYPE` / `ADMIN_STAFF_TYPE` / `STAFF_ROLE_NAME` | `staff` / `Admin` / `Staff` | `admin.*` |
| `DISPATCH_WORKER_ENABLED` | `true` (`false` for canary step 1) | *(always on)* |
| `AGENDA_COLLECTION` | `agendaJobs` | hard-coded |
| `AGENDA_PROCESS_EVERY` / `AGENDA_LOCK_LIFETIME_MS` | `5 seconds` / `600000` | Agenda 4 defaults |

### Borrowed production accounts

| Variable | Where | Meaning |
|---|---|---|
| `SHARED_PROD_CREDENTIALS` | `.env.staging` only (the schema refuses it in any other `APP_ENV`) | `mail,sms,maps,s3`: the production accounts staging may use until it has its own. The guard accepts their keys only behind the staging fences (allowlist mail/SMS drivers, a bucket other than `switchfood`). |

### Secrets plumbing

| Variable | Where | Meaning |
|---|---|---|
| `SECRETS_SOURCE` | `.env.staging`/`.env.prod`: `gcp`; elsewhere `none` | |
| `SECRETS_PROJECT` | `.env.staging`/`.env.prod` | GCP project holding the secret |
| `SECRETS_VERSION` | `.env.staging`/`.env.prod` | pinned secret version number |

---

## 4. Secret Manager

- **One secret per environment**, `switch-server-env`, whose payload is a JSON object with the
  `S` keys above. Fetched once at boot (one API call, ~100 ms), held in memory, never logged.
- IAM: only the App Engine runtime service account gets `roles/secretmanager.secretAccessor`,
  on **this secret only**. You add versions. The CI deploy identity never reads the payload: in
  staging it holds `roles/secretmanager.viewer` on the secret (version states, for the preflight).
- **Rotation:** add a new version → bump `SECRETS_VERSION` in `.env.<env>` → deploy (a new App
  Engine version) → traffic move. Old version disabled after the rollback window. Providers that
  allow two active keys (SendGrid, Firebase SA, Spaces, Maps, Pusher) rotate with zero
  downtime. In staging, `pnpm staging:secret` adds the version (after the boot checks) and bumps
  `SECRETS_VERSION`; the push to `stg` deploys it.
- **Legacy's secrets:** everything in `configs.js` is compromised by definition (it is in git).
  It can only be rotated **after** legacy is retired (plan Phase 7), because legacy can't be
  redeployed with new values. Staging borrows some of them (`SHARED_PROD_CREDENTIALS`), so each
  rotation also needs a new staging secret version, unless staging has its own account by then.
- Fingerprints for the prod-leak guard (plan §3.5) are truncated SHA-256 hashes of prod
  identifiers. You compute them once with `tools/preflight/fingerprint.ts` (which reads the secret
  and prints hashes only), and they are committed in `src/config/guards.ts`.

---

## 5. Local development

### 5.1 Prerequisites

- Node **24** (`.nvmrc`; `nvm use`; this Mac already has 24.18.0 via nvm).
- pnpm: `npm i -g pnpm` once. pnpm then switches itself to the version pinned in
  `packageManager`. (Corepack is optional. Node 25+ no longer bundles it.)
- Docker Desktop.

### 5.2 One command

```bash
pnpm dev:all
```

Creates `.env.local` if missing (`pnpm setup:env`), starts Docker (`pnpm stack:up`: Mongo replica
set + SeaweedFS S3 with the local bucket), the server (`pnpm dev`, `tsx watch` on
`http://localhost:1337`), seeds an empty database (`pnpm seed`), then every app and dashboard in
local mode. The full guide, accounts and per-client switches are in
[04-local-dev.md](04-local-dev.md).

### 5.3 Docker Compose services

| Service | Port(s) | Purpose |
|---|---|---|
| `mongo` | **27018**→27017 | same major as prod (pinned from pre-flight), single-node replica set. 27017 is already used on this Mac by `dzdash-mongo`. |
| `s3` | 9000 | SeaweedFS (`mini`), so local runs the **same** files adapter as prod. Replaced MinIO on 2026-09-21: its community edition is archived, source-only, and gone from Docker Hub. |
| `mailpit` *(not yet)* | 1025 (SMTP), 8025 (UI) | planned; today the fake mail port prints each email, links included, in the server log |
| `parse-dashboard` *(not yet)* | 4040 | planned: Parse Dashboard for the **local** server only |
| `legacy` *(profile `legacy`)* | 1338 | legacy server in the harness (plan §7.2), own db `switch_legacy` |

### 5.4 Seed (`tools/seed`)

Deterministic and idempotent. Refuses to run unless `APP_ENV` is `local`, `test` or `staging`
(the staging run also needs `--i-know-this-is-staging`). Creates:

- Parse Config with every key clients read ([inventory §6](02-contract-inventory.md#6-parse-config-keys-read-by-server-or-clients)).
- Role `Staff`; admin (`staffType: Admin`) and one `Staff` operator.
- Two cities with geofences and fee tables, one **with** `minKmsExtra` and one **without**, so both
  `calculateOrder` branches run.
- Three restaurants with managers, lists and food (discounted and not), valid and expired promos,
  categories, ads.
- Three active drivers placed ~0.5 km, ~2 km and ~4 km from restaurant 1, so dispatch widening is
  observable. One disabled user. Two customers with addresses.
- Prints logins; passwords come from `.env.local`.

### 5.5 Everyday commands

| Command | Does |
|---|---|
| `pnpm dev` | run v2 with hot reload |
| `pnpm test` | unit + integration |
| `pnpm test:parity` | starts legacy + v2 on separate seeded DBs and runs the differential suite |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | quality gates |
| `pnpm seed` / `pnpm db:reset` | reseed / wipe the local DBs |
| `pnpm legacy:fetch` / `pnpm legacy:up` | clone the pinned legacy commit into `.legacy/` / run it on 1338 |
| `pnpm build` | `tsc` → `dist/` |

### 5.6 Pointing a client at your local server (uncommitted edits only)

The local server uses the prod app id, so only the URL changes:

- **switch-ops / switch-finance:** in their own `.env.local`,
  `NEXT_PUBLIC_PARSE_SERVER_URL=http://localhost:1337`.
- **switch-dashboard:** its config's `serverURL` (it already has a commented local line).
- **RN apps:** a debug build with `serverURL` = `http://10.0.2.2:1337` (Android emulator) or your
  LAN IP (device). The configs already carry a commented `http://192.168.1.33` line for this.
  Revert before committing. **No committed change to any client is part of this plan.**

### 5.7 Troubleshooting

- *"port 27017 in use"*: the stack uses 27018 on purpose; check `DATABASE_URI`.
- *Parse Dashboard says "unauthorized"*: `MASTER_KEY_IPS` must include the Docker network
  (`0.0.0.0/0` is allowed in `local` only).
- *Replica set not initiated*: `pnpm stack:up` again (idempotent), or `docker compose restart mongo`.
- *Legacy harness on Apple silicon*: `node:14-bullseye` is multi-arch. If it misbehaves, set
  `LEGACY_NODE_IMAGE=node:16-bullseye` (the harness then adds `--unhandled-rejections=warn`, which
  matches nodejs14).

---

## 6. Staging

Set up and operated by [05-staging.md](05-staging.md) (step by step). In short:

- **Project:** its own GCP project (OD-1), App Engine service `default`, URL
  `https://<project>.<region-id>.r.appspot.com`. Never a `switchfood.net` host: the guard refuses it.
- **Data:** its own Atlas cluster (free M0, MongoDB 8.0), seeded once with `pnpm seed:staging`. No
  prod data, except the Phase 5 rehearsal, which is a separate temporary cluster.
- **Providers:** its own Firebase project (`PUSH_DRIVER=fcm`) and Pusher app. Until it has its own,
  it borrows the production SendGrid, SMS Algérie, Maps and Spaces accounts, listed in
  `SHARED_PROD_CREDENTIALS` and each fenced by the guard: mail and SMS only reach
  `MAIL_ALLOWLIST` / `SMS_PHONE_ALLOWLIST`, files go to the `switchfood-staging` bucket.
- **Deploy:** automatic from `stg` (`.github/workflows/deploy-staging.yml`) with Workload Identity
  Federation (no JSON keys): the ci checks, `gcloud app deploy app.staging.yaml --no-promote`, a
  smoke test of the new version, then the traffic move. A preflight
  (`tools/deploy/staging-preflight.ts`) first checks `.env.staging` against the project.

## 7. Production deploy mechanics

`app.yaml` (initial values mirror legacy's scaling, so capacity is identical at cutover):

```yaml
runtime: nodejs24
instance_class: F2            # OD-8, confirmed by the Phase 4 load test
entrypoint: node --enable-source-maps dist/main.js
inbound_services:
  - warmup
env_variables:
  APP_ENV: production
automatic_scaling:
  min_instances: 1
  max_instances: 5
  target_cpu_utilization: 0.9
  max_concurrent_requests: 70
  target_throughput_utilization: 0.9
  min_pending_latency: 30ms
  max_pending_latency: automatic
```

- **Build happens in CI, not on App Engine.** CI runs the full pipeline, produces `dist/`, then
  `gcloud app deploy --no-promote`. `package.json` sets `"gcp-build": ""`, so the buildpack does
  not run `build` itself (per Google's buildpack docs, a `gcp-build` script replaces the default
  `build` step). The buildpack still runs `pnpm install` for production dependencies from
  `pnpm-lock.yaml`. `engines.node` must match `nodejs24` and `engines.pnpm` pins pnpm. **P1-9
  proves this on staging before it matters.**
- `.gcloudignore` is an allowlist: everything ignored except `dist/`, `package.json`,
  `pnpm-lock.yaml`, `app.yaml`, `.env.prod`, `.env.staging`. Never `.env.local`, `src/`, tests,
  `.legacy/`.
- The prod deploy workflow is manual (`workflow_dispatch`), runs from a signed tag, needs your
  approval (GitHub environment protection), and **always** deploys with `--no-promote`. Traffic
  moves are the manual runbook steps in plan §10, never part of the deploy job.

---

## 8. `package.json` essentials (target)

```jsonc
{
  "name": "switch-server-v2",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@<exact>",          // pinned; P1-9 confirms buildpack support
  "engines": { "node": "24.x", "pnpm": "<exact>" },
  "scripts": {
    "setup": "node tools/setup.mjs",
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "gcp-build": "",
    "start": "node --enable-source-maps dist/main.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run --project unit --project integration",
    "test:parity": "node tools/parity/run.mjs",
    "seed": "tsx tools/seed/index.ts",
    "db:reset": "tsx tools/seed/reset.ts",
    "legacy:fetch": "node tools/legacy-harness/fetch.mjs",
    "legacy:up": "docker compose --profile legacy up -d legacy"
  },
  "pnpm": {
    // pnpm blocks dependency install scripts by default; allow only what needs them
    "onlyBuiltDependencies": ["mongodb-memory-server", "esbuild"]
  }
}
```

(Where pnpm expects `onlyBuiltDependencies`, in `package.json` or `pnpm-workspace.yaml`, depends
on the pinned pnpm major. It is settled in P1-1.)
