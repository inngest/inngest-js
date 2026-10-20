---
"inngest": patch
---

Environment values passed to `step.sandbox` calls such as `commands.run`, `processes.start` and `create` no longer appear in the run trace; only the variable names are recorded. The sandbox still receives the real values. For tokens, prefer `secrets` on `create`, which injects workspace secrets without exposing them.
