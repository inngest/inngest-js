---
"@inngest/ci": patch
---

Mark trace spans with what they are: a command is `kind: "command"`, an extra `sandbox()` is `kind: "sandbox"` named after the sandbox, and saving a sandbox is one `kind: "snapshot"` row instead of a "Save sandbox" group around the SDK's snapshot group. Each statement on a background process (start, `exited()`, `output()`, `kill()`) is its own row. Requires an `inngest` with the snapshot span passthrough. Step IDs are unchanged.
