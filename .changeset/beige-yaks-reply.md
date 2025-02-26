---
"inngest": patch
---

Fix event sending failing in some edge environments due to not finding `global.crypto` or `globalThis.crypto` when creating idempotency IDs
