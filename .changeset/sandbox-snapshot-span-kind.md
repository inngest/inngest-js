---
"inngest": patch
---

Mark the span around a sandbox snapshot's create and wait steps as `kind: "snapshot"`, and let a caller's `"~span"` option replace it, so a snapshot is one statement in a trace. The group has no origin because the statement is the user's; the create and wait steps inside it carry an `inngest@<version>` origin. Step IDs are unchanged.
