---
"inngest": minor
---

Add thread-owned sandboxes to experimental agents: a sandbox in an agent's `sandboxes` is snapshotted when its run ends (including cancel and timeout) and restored on first use by the thread's next run, so files survive across runs. A run that never uses the sandbox restores nothing.
