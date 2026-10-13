---
"@inngest/ci": minor
---

Group a run's steps into trace spans (one per job, one per command, one per extra machine), name CI's own steps for what they do, and mark them as CI's work so a trace can tell them from yours. Saving a sandbox is one `snapshot` row.

`@inngest/ci` now needs `inngest` 4.23.1 or later, which takes a snapshot's own trace span and always has the span API; older SDKs are no longer supported.
