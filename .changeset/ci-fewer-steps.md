---
"@inngest/ci": patch
---

Commands take far fewer steps. A command that ends within a few seconds is one step, and a longer one adds a step per 30 seconds instead of a sleep and a check every few seconds, so pipelines stay well inside a run's step limit.
