---
"inngest": major
---

Clients and functions now require IDs

When instantiating a client using `new Inngest()` or creating a function via `inngest.createFunction()`, it's now required to pass an `id` instead of a `name`.

Previously only `name` was required, but this implied that the value was safe to change. Internally, we used this name to _produce_ an ID which was used during deployments and executions.

See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).
