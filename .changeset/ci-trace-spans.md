---
"@inngest/ci": minor
---

Group a run's steps into trace spans (one per job, one per command, one per extra machine), name CI's own steps for what they do, and mark them as CI's work so a trace can tell them from yours. Give a job a `name` to change what its span is called. Every span has a kind (job, sandbox, command, snapshot, github or attempt), and each statement on a background process (`output`, `exited`, `kill`) is a row of its own. Saving a sandbox is one `snapshot` row on an `inngest` that takes the span, and the span is opened by CI on older ones.
