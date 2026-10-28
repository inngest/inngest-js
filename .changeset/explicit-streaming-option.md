---
"inngest": patch
---

Fix `streaming: false` in `serve()` being ignored when the `INNGEST_STREAMING` env var is set. An explicit `streaming` option now takes precedence over the env var.
