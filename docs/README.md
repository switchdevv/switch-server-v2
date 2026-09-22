# switch-server v2 — docs

Read in order:

1. [01-rewrite-plan.md](01-rewrite-plan.md): why, target stack, Parse 4.3 → 9.10 option
   mapping, compatibility hot spots, verification strategy, phases, cutover/rollback runbook,
   open decisions, risks.
2. [02-contract-inventory.md](02-contract-inventory.md): the exact behaviour v2 must keep. All 50
   cloud functions, 11 triggers, the dispatch job, push/Pusher/SMS/email payloads, Config keys,
   error strings, and legacy quirks.
3. [03-environments-and-dev-setup.md](03-environments-and-dev-setup.md): environments, the
   `.env.*` files, the variable catalogue, Secret Manager, staging and deploy mechanics.
4. [04-local-dev.md](04-local-dev.md): run the server, every app and every dashboard locally
   with seeded data (`pnpm dev:all`). Start here to work on anything.
5. [05-staging.md](05-staging.md): CI, the staging environment and its automatic deploys from
   `main`: one-time setup step by step, secrets, seeding, rollback, troubleshooting.

Two rules that override everything in these docs:

- **Nothing breaks in the apps and dashboards.** Parity first; every difference must be listed in
  the Deviation Register (plan §9).
- **Never test in production.** No test calls, accounts, orders or pushes against
  `api.switchfood.net`, and no local process pointed at production data or accounts.
