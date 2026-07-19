---
"@emdash-cms/sandbox-workerd": minor
---

Adds the `storage/batch` bridge method so sandboxed plugins on the workerd-on-Node runtime get the same atomic multi-document batch (`ctx.storage.batch`) as in-process plugins. Every op's declared collection is validated before execution (a batch cannot smuggle a write to an undeclared collection), and the batch runs in a real transaction against the host database with the identical `BatchResult` shape as the Cloudflare D1 path.
