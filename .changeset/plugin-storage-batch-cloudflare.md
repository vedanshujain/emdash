---
"@emdash-cms/cloudflare": minor
---

Adds the `storage/batch` bridge method so sandboxed plugins on Cloudflare get the same atomic multi-document batch (`ctx.storage.batch`) as in-process plugins. On D1 the batch runs through `env.DB.batch()` with interleaved zero-rows guard assertions, so a failed guard rolls back every coupled write. Returns the identical `BatchResult` shape as the in-process and workerd paths.
