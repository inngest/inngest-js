---
"@inngest/ci": minor
---

`cd` and `export` now carry between the commands of a job, like a terminal: `` await $`cd app` `` then `` await $`pnpm test` `` runs the test in `app`, and `` await $.sh`export CI=1` `` applies to the commands after it. A command's own `.cwd()` and `.env()` still apply to that command alone. Each machine has its own state, and a job starts from the default directory. Commands called together still run in parallel, each from the state when it was called. Requires `inngest` 4.27.0 or later.
