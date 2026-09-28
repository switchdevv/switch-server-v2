# ADR 0003 — Drivers' prepaid wallets: a derived balance, orders locked at purchase

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-28 |
| **Plan** | [01-rewrite-plan.md §9, D-25](../01-rewrite-plan.md#9-deviation-register) |
| **Code** | `src/domain/driver-wallet.ts`, `src/cloud/driver-wallets.ts`, `src/cloud/wallet-book.ts`, `src/cloud/functions/driver-wallet.ts`, the gate in `beforeSave _User` (`src/cloud/triggers/index.ts`) |
| **Spec** | `switch-finance/docs/driver-wallet-backend.md` |

## Context

Cash orders leave the platform's service fee in the driver's hands. Finance has drivers prepay it
for a batch of orders (say 50), so a driver who quits owes nothing, and pays back what is left
when they go. That was a spreadsheet. The business asked for it in the platform:

- only the driver's **delivered** orders use the prepayment;
- a driver can't go online without enough of it, and is warned at 10 orders left;
- the driver app shows **orders**, never money;
- orders are **locked at purchase**: a later fee change doesn't change what was bought, and a
  refund pays each order back at what it cost;
- what an order uses is the dashboard's existing per-driver formula (cash: the service fee, or
  `service − delivery` on a free delivery; otherwise `−delivery`), so a free delivery, whose fee
  Switch owes the driver, gives orders back at that order's price.

An order doesn't stay as it was delivered. Ops re-open it, cancel it, correct its money or hand
it to another driver: through `editOrder` / `assignDriver` / `chooseDriver` / `deleteOrders`,
through their plain REST unassign, from the Parse Dashboard, and, during the canary, through the
legacy server. `Order` has no delivered-at column and must keep having no triggers (ADR 0002).

## Decision

**The balance is derived, never stored.** A wallet is its manual entries (top-ups, refunds,
adjustments; voided ones left out) plus its driver's orders that are delivered (status ≥ 3), not
canceled, and created since the wallet started — read afresh on every request. Whatever changed
an order, and whoever did it, the next read has it right: nothing has to be told.

**One expression decides what an order does**: an aggregation over `Order` in Parse's storage
format (`unitStages` in `src/cloud/driver-wallets.ts`). It computes the formula's money, divides
it by the order's own `options.service` — the fee of the day it was placed, which is what locks
the price — and keeps hundredths of an order, so a free-delivery credit of 2.6 orders is exact.
An order that carried no service fee (a `freeall` promo) is priced at today's fee in the
driver's city. The same stages serve one driver's balance, the ledger lines and the all-drivers
list, so they can't disagree.

**Lots, oldest used first.** Everything that adds orders is a lot with a price (a top-up, an
adjustment, a free-delivery credit). Deliveries use the oldest orders, so the orders left are
always the newest ones received: their value — the refund — is a walk over the lots from the
newest until the balance is covered. A partial refund or a negative adjustment takes the oldest
of what is left, keeping that true.

**Storage** is two plain MongoDB collections, like `driverOffers`: `driverWallets` (start,
closed, the last alert level) and `driverWalletEntries` (append-only; keyed by the client's
request id, so a retry is recorded once). No client can reach them. Voiding marks an entry and
drops it from every sum; nothing is deleted.

**The gate is `beforeSave _User`.** A driver goes online by saving `driverActive: true` on their
own row, and every way of getting orders needs `driverActive` (the automatic search,
`assignDriver`, the ops queue). So refusing that save — `142 WALLET_EMPTY` — while the wallet is
enforced and short is enough, reaches old app builds too, and costs nothing on other saves.

**The rules are global, with regional overrides.** Config `driverWallet` holds `enforced`,
`minOrders` and `lowOrders`, and under `regions.<cityId>` only the values a region sets itself.
The global `enforced` is a master switch (the business's choice): off, nothing is enforced
anywhere; on, every region is except one set `enforced: false`. Thresholds are the region's
where set, else global (`walletSettingsFor`), read from the driver's current `city` on every
check. It is one Config key written whole by
`updateConfigs`: two admins saving at the same moment keep the last save.

**Alerts and staff notes are side effects of the writes v2 owns.** After `finishDriver` and the
four staff order functions, a detached step warns the driver once per level (a compare-and-set
on the wallet's `alert`) and sets an empty driver offline. The staff functions also read the
order before their write, so the ledger can say "status 3 → 2 — 1 order returned". The balance
never depends on these steps.

Rejected:

- **A stored balance kept by hooks** on every path that changes an order. The REST unassign, the
  Parse Dashboard and legacy reach no hook, so it would drift, and would need a recount job
  whose results then contradict the ledger.
- **An `afterSave Order` trigger.** ADR 0002's atomic claims are only safe while `Order` has no
  triggers.
- **A money balance shown as `balance ÷ today's fee`.** Simpler, but a fee change would change
  what drivers had bought; the business chose locked orders.
- **Parse classes for the wallet.** They would need a hand-made schema and CLP in the Parse
  Dashboard, and one CLP mistake would let a driver write their own balance.

## Consequences

- Balances are right during the canary even when legacy finishes the order; only the gate, the
  pushes and the ledger notes need v2.
- Each balance read aggregates the driver's orders since the wallet started, served by `Order`'s
  `{ _p_driver: 1, _created_at: -1 }` index (confirm it in Atlas before enforcing). The
  all-drivers list aggregates every wallet at once. If that grows slow, per-driver checkpoints
  are the next step, at the cost of no longer following edits to orders before the checkpoint.
- An order counts by its `createdAt`, the only date `Order` has: one placed before a wallet's
  start and delivered after it is not counted. Finance picks the start when carrying a manual
  balance over.
- Edits made outside v2 (REST, Dashboard, legacy) move balances without a note on the ledger.
- A `freeall` order is priced at today's city fee, so its credit follows fee changes; every other
  order keeps its own price.
