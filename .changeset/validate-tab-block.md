---
"@emdash-cms/blocks": patch
---

Fixes `validateBlocks` rejecting a valid `tab` block with "Unknown block type 'tab'". Tab panels and their nested blocks are now validated too.
