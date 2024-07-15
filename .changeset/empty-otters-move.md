---
"inngest": patch
---

Loosen typing on `match` options and mark as deprecated to remove performance concerns in codebases with a very large number of event types; all `match` fields are now simply typed as `string`
