# ADR 0002 — One driver per order: atomic claims on the Order document

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-21 |
| **Plan** | [01-rewrite-plan.md §9, D-20](../01-rewrite-plan.md#9-deviation-register) |
| **Code** | `src/cloud/order-claims.ts`, `acceptDriver` / `cancelDriver` in `src/cloud/functions/order-driver.ts`, the exhausted round in `src/jobs/choose-driver.ts` |

## Context

Three writes decide who drives an order, and legacy does each of them as read, check, then save:

- `acceptDriver` reads `driver`, and if it is empty saves the caller. Drivers who accept at the
  same moment all read an empty `driver`, all save, and all get `1`. The last write wins the row,
  and the driver app's follow-up `checkDriver` only catches the loser when it runs after that last
  write. Dispatch offers an order to every nearby driver, so this is a real risk. The new test
  reproduced it at once: 6 of 8 concurrent accepts answered `1`.
- `cancelDriver` clears `driver` for any caller. Take a driver whom ops took off the order and
  whose push never arrived. They can clear the new holder, and without a reason that restarts
  dispatch, so a third driver can take the order.
- The exhausted dispatch round reads the order, searches, and saves `canceled = true` later. A
  driver who accepts in between ends up holding a canceled order.

Parse can't express "write only if": its REST and SDK saves are unconditional, and a `beforeSave`
check would read then write too.

## Decision

Each of those changes is a single MongoDB `updateOne` on the `Order` document, with the condition
inside the filter. MongoDB matches and writes one document atomically, so of two racing writers
exactly one matches.

| Change | Filter | Update |
|---|---|---|
| `claim` | `_id`, `canceled ≠ true`, `_p_driver ∈ {null, me}` | `_p_driver = '_User$me'` |
| `release` | `_id`, `_p_driver = me` | `_p_driver = null` |
| `cancelUnclaimed` | `_id`, `_p_driver = null` | `canceled = true` |

Every update also sets `_updated_at`. The values are Parse's own storage format, and a test pins
it against Parse's writes. A failed claim then reads the order once, only to choose
`ORDER_CANCELED` or `ORDER_FULLFILLED`, with legacy's precedence. Order ids come from clients, so
anything but a string counts as no such order before a filter is built.

Rejected:

- **An increment token** (`claim` counter, first to reach 1 wins). Every path that clears the
  driver would have to reset it, including switch-ops' plain REST unassign, which never reaches
  cloud code.
- **A lock document per order.** A second write, orphaned by a crash between the lock and the
  save, and the same reset problem.
- **Parse internals** (`DatabaseController.update` with an extended query). Unversioned private
  API with no advantage over the driver we already use for `agendaJobs`.

## Consequences

- Of drivers accepting at once, exactly one wins, and a stale driver can't release someone
  else's order. Dispatch never cancels an order a driver holds.
- These writes bypass Parse. That is safe only while `Order` has **no triggers** and **LiveQuery
  stays off**, both true today. Adding either means moving these writes back into Parse.
- They rely on prod's `Order.driver` column (Pointer `_User`). Parse drops a `_p_` field it has no
  column for when reading, so the test world declares the column the way prod has it.
- During the canary, legacy instances still read then write, so they can overwrite a v2 claim.
  The guarantee is complete once all traffic is on v2.
- Staff overrides (`assignDriver`, `chooseDriver`, `editOrder`, switch-ops' unassign) stay
  unconditional on purpose.
