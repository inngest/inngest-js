---
"inngest": patch
---

Fix `sandboxes.list()`, `sandboxes.snapshots.list()` and sandbox process lists throwing `SandboxValidationError` when the API returns an empty list without a `data` field.
