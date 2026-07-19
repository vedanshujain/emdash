---
"emdash": minor
---

Adds `ctx.storage.batch([...])` — apply several conditional writes (`insert` / `updateIf`) across multiple documents and collections all-or-nothing. The batch commits only if every op's guard passes; otherwise it rolls back the whole batch and reports which op failed (`{ applied: false, failedIndex, reason, conflictField? }`). This is the atomic primitive behind coupled writes like claim ∧ decrement ∧ flip.

Atomic on Postgres and SQLite (a real transaction) and on Cloudflare D1 (raw `env.DB.batch()` with interleaved zero-rows guard assertions). Guard and uniqueness outcomes are reported, never thrown; malformed ops (float delta, a field in both `set` and `delta`, unknown op, empty ops array, `updateIf` with neither `set` nor `delta`, `insert` without `data`) throw. A batch is capped at **50 ops** (aligned with D1's per-batch statement / bound-parameter limits — each guarded op compiles to up to two D1 statements); an over-limit batch throws. A collection named `batch` is now rejected at declaration time (it would collide with the new method).

Caveat (inherited from the numeric-guard support): numeric guards inside batch ops fall back to a sequential scan on Postgres. On D1's failure path, `failedIndex` / `reason` are best-effort under concurrent writers (the committed state is always correct — resolve by durable state).
