---
"emdash": minor
---

Adds `insert` (insert-once) and `updateIf` (predicate-guarded atomic update) to plugin storage collections. `insert` creates a document only if its id is free and no declared unique index is violated; `updateIf` applies a wholesale `set` and/or integer `delta` in a single guarded statement, so concurrent guarded decrements (e.g. inventory) can no longer oversell. A collection's declared `uniqueIndexes` are now materialized as real unique indexes when the plugin installs — installation fails loudly if a unique index cannot be created (for instance because existing data already violates it).
