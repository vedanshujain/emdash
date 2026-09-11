---
"@emdash-cms/blocks": minor
---

Adds an optional `row_action` to the `table` block, so plugin list screens can drill into a row directly instead of pairing the table with a separate select-and-open form. Each row gains a labelled activation control and becomes clickable; activating it dispatches a `block_action` carrying the row's identity, taken from the `value_key` property if set and the whole row otherwise. Tables without `row_action` are unchanged.
