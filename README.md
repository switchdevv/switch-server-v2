# switch-server-v2

The Switch backend. It runs Parse Server 9 on Node 24 and is written in TypeScript.

It replaces the old `switch-server` (Parse Server 4.3, Node 14). It uses the same database and
answers requests exactly like the old server, so the apps and dashboards work with it unchanged:
switch-food, switch-driver, switch-manager, switch-dashboard, switch-ops and switch-finance.

**New here?** Start with the [onboarding guide](docs/00-onboarding.md). It takes you from an
empty laptop to running everything locally and shipping a change to staging.

## Status

- All 50 cloud functions, 11 triggers and the automatic dispatch job are ported.
- Staging is live and deploys automatically from the `stg` branch.
- Production still runs the old `switch-server`. The production pipeline is ready: v2 goes to
  production as a version next to the old server's, by manual runs from `main`, and takes the
  traffic in one switch ([docs/06-production.md](docs/06-production.md)).
- The automated comparison against the old server (plan P1-7) is not built yet. For now, tests
  written by hand check that v2 behaves like the old server.

## Good to know

- **The old server's behaviour is the contract.** The apps depend on it, odd parts included
  (error messages, misspellings, response shapes). Any intentional difference is listed in the
  [Deviation Register](docs/01-rewrite-plan.md#9-deviation-register).
- **We never test against production** (`api.switchfood.net`): no test accounts, orders, pushes
  or calls. Use your local setup or staging. Outside production, the server refuses to start if
  its config contains a production value (`src/config/guards.ts`).

## Quick start

You need Node 24, pnpm and Docker Desktop. The full setup is in the
[onboarding guide](docs/00-onboarding.md).

```bash
pnpm install
pnpm setup:env   # once: creates .env.local with random local keys
pnpm dev:all     # Docker + server + test data + every app and dashboard
```

The server runs on http://localhost:1337. Every seeded account uses the password `switch-dev`.
To run the server alone:

```bash
pnpm stack:up    # MongoDB (port 27018) and a local S3 (port 9000) in Docker
pnpm dev         # the server, restarts when you save a file
pnpm seed        # once: fills the empty local database with test data
```

## Scripts

| Script                                  | What it does                                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                              | Server with hot reload (`APP_ENV=local`, reads `.env.local`)           |
| `pnpm dev:all`                          | Docker + server + seed + every client (`--only`, `--skip web\|mobile`) |
| `pnpm stack:up` / `stack:down`          | Start / stop the local Docker services                                 |
| `pnpm seed` / `db:reset`                | Seed an empty local database / empty it and seed again                 |
| `pnpm test`                             | Unit + integration tests (in-memory MongoDB, fake outside services)    |
| `pnpm test:unit` / `test:integration`   | One test suite                                                         |
| `pnpm check`                            | Typecheck + lint + tests                                               |
| `pnpm typecheck` / `lint` / `format`    | Quality checks (CI runs `format:check`)                                |
| `pnpm build` / `start`                  | Compile to `dist/` / run the compiled server                           |
| `pnpm setup:env`                        | Create `.env.local` from `.env.example` (never overwrites it)          |
| `pnpm fingerprint`                      | Hash values from stdin for the production-leak guard                   |
| `pnpm staging:secret`                   | Add a new version of the staging secrets and pin it in `.env.staging`  |
| `pnpm staging:preflight --project X`    | Check `.env.staging` against the staging project, like the deploy does |
| `pnpm seed:staging`                     | Seed an empty staging database (`SEED_PASSWORD`, 12+ characters)       |
| `pnpm production:secret`                | Add a new version of the production secrets and pin it in `.env.prod`  |
| `pnpm production:preflight --project X` | Check `.env.prod` against the production project, like the deploy does |

## CI and deploys

- **Every pull request** runs `.github/workflows/ci.yml`: install, typecheck, lint, format check,
  tests, build, `pnpm audit` and a secret scan (gitleaks).
- **Every push to `stg`** runs the same checks, then deploys to staging
  (`.github/workflows/deploy-staging.yml`). The new version gets traffic only after its `/health`
  and `/config` answer. The five previous versions are kept for rollback.
- **Production** deploys only by hand, from `main`: **deploy-production** adds a version with no
  traffic after the same checks, and **promote-production** moves the traffic (100%, or a 10%/50%
  canary), which is also how to roll back. Setup, the switch from the old server, rollback:
  [docs/06-production.md](docs/06-production.md).

The server runs on Google App Engine (`nodejs24`). CI builds it, and `.gcloudignore` uploads only
`dist/`, the package manifests and the non-secret env files.

## Configuration

All settings are environment variables, checked when the server starts (`src/config/env.ts`).
`.env.example` explains each one. `APP_ENV` picks the environment:

| `APP_ENV`    | Settings come from                      | Outside services (push, SMS, email…)                                     |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `local`      | `.env.local` (generated, not committed) | fakes, printed in the server log                                         |
| `test`       | `.env.test` (committed, fake values)    | fakes                                                                    |
| `staging`    | `.env.staging` + Google Secret Manager  | real; its own Firebase and Pusher, production mail/SMS/maps/files fenced |
| `production` | `.env.prod` + Google Secret Manager     | real                                                                     |

Committed env files never contain secrets (a test checks this). Secrets live in Secret Manager,
and `.env.staging` / `.env.prod` pin which version the server reads (`SECRETS_VERSION`).

## Code layout

```
src/
  main.ts            entry point: config → secrets → safety checks → start → clean shutdown
  app.ts             createApp(env): Express + Parse Server (also used by the tests)
  config/            env schema, .env loading, Secret Manager, production-leak guard, Parse options
  cloud/
    index.ts         the list of every cloud function and trigger (a test pins the 50 + 11 names)
    functions/       cloud functions, one file per area
    triggers/        the 11 triggers
    cascade.ts       shared cascading deletes and manager permission updates
    errors.ts        error messages, copied word for word from the old server
    guards.ts        requireUser / requireStaff
    notify.ts        push messages for staff and drivers
    wire-json.ts     makes in-process cloud calls return exactly what an HTTP call would
  domain/            pure business rules: delivery fees, ratings, new-user defaults, translations
  jobs/              automatic dispatch (chooseDriver)
  ports/ adapters/   every outside service behind an interface, with real and fake versions
  i18n/              translations.json, identical to the old server's
test/                unit and integration tests (real Parse Server + in-memory MongoDB)
tools/               dev:all, seed scripts, env setup, staging/production secrets and deploy checks
docs/                onboarding, plan, contract, environments, local dev, staging, production, decisions
```

## Docs

0. [Onboarding](docs/00-onboarding.md): new developer setup, from zero to a staging deploy.
1. [Rewrite plan](docs/01-rewrite-plan.md): why v2 exists, the target stack, the phases, the
   Deviation Register, and the production cutover and rollback.
2. [Contract inventory](docs/02-contract-inventory.md): every function, trigger and response
   shape that must not change.
3. [Environments](docs/03-environments-and-dev-setup.md): `.env` files, every variable, secrets.
4. [Local development](docs/04-local-dev.md): the whole platform on your Mac, seeded accounts.
5. [Staging](docs/05-staging.md): how staging was set up, deploys, rollback, troubleshooting.
6. [Production](docs/06-production.md): setup, the switch from the old server, releases,
   rollback, decommissioning the old server.
7. [Decisions (ADRs)](docs/adr/): design decisions and why they were made.
