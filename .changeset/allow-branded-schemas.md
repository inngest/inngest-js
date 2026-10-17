---
"inngest": patch
---

Allow branded types (e.g. Zod's `.brand()`) in `eventType()` schemas. Brands only change the static output type and never the runtime value, so they are no longer reported as unsupported transforms.
