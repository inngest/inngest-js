---
"@inngest/ci": patch
---

A pipeline run that fails or is cancelled without reaching its own cleanup now also deletes the snapshots its builds named for it, not just its machines.
