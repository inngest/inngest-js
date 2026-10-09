---
"inngest": patch
---

Mark the span around a sandbox snapshot's create and wait steps as `kind: "snapshot"` with an `inngest@<version>` origin, and let a caller's `"~span"` option replace it, so a snapshot is one statement in a trace. Step IDs are unchanged.
