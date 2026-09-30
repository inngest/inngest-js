---
"inngest": patch
---

Stop persisting `step.sandbox` operations as step input, and stop storing a started process's argv in its step output, so literal environment values, argv, and working directories passed to sandboxes are no longer kept in run state or shown in the dashboard.
