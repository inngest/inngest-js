---
"inngest": patch
---

`kv` operations in `inngest/experimental/agents` no longer trigger the "Duplicate step ID ... detected across parallel chains" warning when the same operation on the same key is repeated with other work in between (the thread state writes of an agent, `kv.thread.update(key)` in a loop). A repeat now gets the ID the engine indexes it to (`kv.get:run:a`, then `kv.get:run:a:1`), so runs already in flight replay against the same steps.
