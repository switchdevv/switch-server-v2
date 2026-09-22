# switch-server-v2

The Switch backend: Parse Server 9 on Node 24, in strict TypeScript. It replaces `switch-server`
(Parse Server 4.3, Node 14) behind the same URL, on the same database, and keeps the same wire
protocol, so none of the clients changes: switch-food, switch-driver, switch-manager,
switch-dashboard, switch-ops and switch-finance.

**Status:** all 50 cloud functions, 11 triggers and the automatic-dispatch job are ported. The
legacy parity harness (plan P1-7, Phase 2) is not built yet, so parity is still checked by
hand-written tests. Deploys to staging from `stg` once staging is set up
([docs/05-staging.md](docs/05-staging.md)); never to production.

Two rules come before everything else:

- **Nothing breaks in the apps and dashboards.** Legacy behaviour is the contract, quirks
  included. Every difference is listed in the Deviation Register
  ([plan §9](docs/01-rewrite-plan.md#9-deviation-register)).
- **Never test in production.** No test calls, accounts, orders or pushes against
  `api.switchfood.net`. Outside production, the server refuses to boot with any production value
  (`src/config/guards.ts`).

## Quick start

Requires Node 24, pnpm and Docker Desktop.

```bash
pnpm install
pnpm dev:all
```

This starts Mongo and a local S3 (SeaweedFS) in Docker, the server on http://localhost:1337, seeds an empty
database, and runs every app and dashboard against it. The server alone:

```bash
pnpm setup:env   # once: writes .env.local with random local keys
pnpm stack:up    # Mongo (27018) + S3 (9000)
pnpm dev         # http://localhost:1337, hot reload
pnpm seed        # once: local test data (password: switch-dev)
```

The full guide, seeded accounts and per-client setup are in
[docs/04-local-dev.md](docs/04-local-dev.md).

## Scripts

| Script                                | Does                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                            | Server with hot reload (`APP_ENV=local`, reads `.env.local`)           |
| `pnpm dev:all`                        | Docker + server + seed + every client (`--only`, `--skip web\|mobile`) |
| `pnpm stack:up` / `stack:down`        | Start / stop the local Docker services                                 |
| `pnpm seed` / `db:reset`              | Seed an empty local database / empty it and seed again                 |
| `pnpm test`                           | Unit + integration tests (in-memory MongoDB, fake outside services)    |
| `pnpm test:unit` / `test:integration` | One suite                                                              |
| `pnpm check`                          | Typecheck + lint + tests                                               |
| `pnpm typecheck` / `lint` / `format`  | Quality checks (`format:check` in CI)                                  |
| `pnpm build` / `start`                | Compile to `dist/` / run it (production entry)                         |
| `pnpm setup:env`                      | Create `.env.local` from `.env.example` (never overwrites)             |
| `pnpm fingerprint`                    | Hash values from stdin for the prod-leak guard                         |
| `pnpm staging:secret`                 | Add a staging secret version (hidden prompts, boot checks) and pin it  |
| `pnpm staging:preflight --project X`  | Check `.env.staging` against the staging project, as the deploy does   |
| `pnpm seed:staging`                   | Seed the empty staging database (`SEED_PASSWORD`, 12+ characters)      |

CI (`.github/workflows/ci.yml`, every pull request) runs install, typecheck, lint, format check,
tests, build, `pnpm audit` (high) and gitleaks. Every push to `stg` runs the same checks and then
deploys to staging (`.github/workflows/deploy-staging.yml`).

## Layout

```
src/
  main.ts            process entry: config → secrets → guard → start → graceful shutdown
  app.ts             createApp(env): Express + Parse Server mounted at / (testable factory)
  config/            env schema (zod), .env loading, Secret Manager, prod-leak guard, Parse options
  cloud/
    index.ts         the registry: every function and trigger (a test pins the 50 + 11 names)
    functions/       cloud functions, one file per legacy area
    triggers/        the 11 triggers
    cascade.ts       shared cascading deletes and manager ACL rewrites
    errors.ts        legacy error strings, verbatim (misspellings are contract)
    guards.ts        requireUser / requireStaff (legacy's exact role check)
    notify.ts        FCM message builder, staff and driver notifications
    wire-json.ts     keeps in-process cloud-code calls identical to legacy's HTTP round trip
  domain/            pure rules: delivery fees, ratings, new-user defaults, i18n
  jobs/              automatic dispatch (chooseDriver) on Agenda 4's document protocol
  ports/ adapters/   every outside service behind an interface; real adapters and recording fakes
  i18n/              translations.json, byte-identical to legacy
test/                unit and integration tests (real Parse Server + in-memory MongoDB)
tools/               dev:all, seed (local, staging), env setup, staging secret + deploy preflight
docs/                plan, contract inventory, environments, local dev, staging, ADRs
```

## Configuration

Everything is set through environment variables, validated at boot (`src/config/env.ts`).
`.env.example` documents each one. Per environment (`APP_ENV`):

| `APP_ENV`    | Values from                                                | Outside services                                                  |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `local`      | `.env.local` (generated, gitignored)                       | fakes, printed in the server log                                  |
| `test`       | `.env.test` (committed, fake)                              | fakes                                                             |
| `staging`    | `.env.staging` + Secret Manager (pinned `SECRETS_VERSION`) | real: own Firebase/Pusher; production mail/SMS/maps/Spaces fenced |
| `production` | `.env.prod` + Secret Manager (pinned `SECRETS_VERSION`)    | real                                                              |

Committed env files hold no secrets; a test fails if one does. Production refuses to boot if a
secret arrives from the plain environment instead of Secret Manager.

## Deployment

App Engine `nodejs24`. The build runs in CI; `.gcloudignore` uploads only `dist/`, the manifests
and the non-secret env files, and App Engine installs the production dependencies with pnpm.

- **Staging** (its own project): automatic from `stg` (`main` is reserved for production). The tested build goes out as a new version
  without traffic, takes the traffic after its `/health` and `/config` answer, and the newest five
  old versions stay for rollback. Setup and rollback: [docs/05-staging.md](docs/05-staging.md).
- **Production** (same service as legacy): no workflow. A new version with `--no-promote`, then
  manual traffic moves (canary, rollback) in the cutover runbook
  ([plan §10](docs/01-rewrite-plan.md#10-cutover-and-rollback-runbook-production)).

## Docs

1. [Rewrite plan](docs/01-rewrite-plan.md): why, target stack, Parse option mapping, verification,
   phases, Deviation Register, cutover and rollback.
2. [Contract inventory](docs/02-contract-inventory.md): every function, trigger, payload and quirk
   that must not change.
3. [Environments](docs/03-environments-and-dev-setup.md): `.env` files, variables, secrets, staging.
4. [Local development](docs/04-local-dev.md): the whole platform on your Mac.
5. [Staging](docs/05-staging.md): CI/CD, one-time setup step by step, secrets, rollback.
6. [ADRs](docs/adr/): decisions, starting with the dispatch job store.
