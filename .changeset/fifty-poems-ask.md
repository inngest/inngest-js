---
"inngest": patch
---

Fix memory growth when re-creating functions with the same ID. The new definition now replaces the old one in `client.funcs`. `connect()` without `functions` now warns and uses the latest definition instead of throwing `Duplicate function ID`.
