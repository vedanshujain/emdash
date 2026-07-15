---
"emdash": patch
---

Fixes plugin storage `query()`, `count()`, and index creation on Postgres. Queries and unique/expression indexes on stored JSON fields previously failed with an "operator does not exist" error, and numeric range/equality/`in` filters compared values as text (so `stock >= 10` also matched `9`), causing over-counting. Numeric guards now compare numerically and counts are returned as numbers. SQLite is unchanged.
