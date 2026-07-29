---
"@emdash-cms/blocks": patch
---

Fixes Block Kit `select` fields displaying the raw option value — or nothing at all — instead of the selected option's label. Adds an optional `placeholder` for the unselected state, defaulting to the label of an option whose `value` is `""` and otherwise to `Select...`. Submitted values are unchanged.
