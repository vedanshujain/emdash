---
"emdash": patch
---

Fixes plugin storage `query()`, `count()`, ordering, and index creation on Postgres. Queries and unique/expression indexes on stored JSON fields previously failed with an "operator does not exist" error; numeric range/equality/`in` filters compared values as text (so `stock >= 10` also matched `9`), causing over-counting; and `orderBy` on a numeric field sorted lexically (`10, 100, 9`) instead of numerically. Numeric guards now compare and order numerically, and counts are returned as numbers.

Numeric filters are now type-guarded on both dialects: a stored value that isn't a JSON number is excluded from a numeric comparison (evaluates to no-match) instead of being compared as text — previously such a value could match, and on Postgres an untyped cast would have thrown. Numeric predicates on Postgres are served by a sequential scan (the per-field expression index is text-typed, since field types aren't known when indexes are created). SQLite behavior is otherwise unchanged.
