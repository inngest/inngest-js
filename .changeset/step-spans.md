---
"inngest": patch
---

Traces for `step.sandbox` steps now show what each step did: its `inngest.sandbox` metadata names the action, the method called, and the machine, command, process, or snapshot involved. `snapshot()` appears as one group, "Create snapshot" and "Wait for snapshot", with its internal steps marked as Inngest's own. Also adds internal, unstable `group["~span"]()`, `"~span"`, and `"~origin"` for grouping steps and marking library-run steps in traces.
