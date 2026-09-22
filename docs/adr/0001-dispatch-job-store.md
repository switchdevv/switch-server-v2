# ADR 0001 — Dispatch job store: in-repo Agenda 4 protocol, not Agenda 6

| | |
|---|---|
| **Status** | Accepted, provisional. Confirmed once the J-tests run against documents written by real Agenda 4.1.3 (see "Open"). |
| **Date** | 2026-09-21 |
| **Plan** | [01-rewrite-plan.md §6.6](../01-rewrite-plan.md#66-dispatch-job-agenda) (spike S-3, fallback) |
| **Code** | `src/jobs/legacy-agenda-store.ts`, `src/jobs/choose-driver.ts` |

## Context

Automatic dispatch (`chooseDriver`) is live legacy behaviour. Legacy runs Agenda 4.1.3 on the
`agendaJobs` collection, with a worker in every App Engine instance. During the canary, legacy
and v2 instances share that collection, so each side must run the other's rows (J-1, J-2), keep
"unique on `data.objectId`" (J-3), cancel by a **partial** data match (J-4), never run legacy's
orphan rows with `nextRunAt: null` (J-5), and keep the 5 s poll and 10 min lock (J-6).

Agenda 6 is an ESM-only TypeScript rewrite with a pluggable backend. Its `cancel({ data })`
matches the whole `data` object, and proving its document compatibility with 4.1.3 is the whole
of spike S-3.

## Decision

Take the plan's fallback: `LegacyAgendaStore`, about 100 lines on the MongoDB 7 driver that do
exactly the reads and writes Agenda 4.1.3 does (lock query and sort, `schedule` insert shape,
unique upsert, `deleteMany` for remove/cancel, lock release on stop). No Agenda dependency.

## Consequences

- One small, fully tested component instead of a framework whose v4 compatibility is unproven.
- Differences from 4.1.3, none visible to clients:
  - **D-18.** Starting dispatch does one upsert and then removes the row when the first round
    runs. Legacy's un-awaited `job.run()` plus a second `job.save()` race, which is how legacy
    leaves orphan rows with `nextRunAt: null`. v2 leaves none. It still ignores legacy's orphans
    (J-5).
  - A v2 instance locks at most `concurrency` (5) due jobs per scan. Agenda 4 with the default
    `lockLimit: 0` locks every due job and runs 5 at a time. Other instances pick up the rest.
  - On SIGTERM the worker lets running rounds finish, then unlocks the jobs it holds (D-15).

## Open

The J-tests in `test/integration/dispatch.test.ts` currently seed **hand-written** copies of
Agenda 4.1.3 documents, and J-2 only checks field names. The plan requires documents **written by
Agenda 4.1.3 itself** (P2-2), and a legacy worker running rows written by v2. Both come with the
legacy harness (P1-7). Until then this ADR stays provisional.
