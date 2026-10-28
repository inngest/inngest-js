---
"inngest": minor
---

Experimental agents: a sandbox in an agent's `sandboxes` now belongs to the thread. It is snapshotted when a run that used it ends (including cancel and timeout) and restored on first use by the thread's next run, so files survive across runs. A run that never uses the sandbox restores nothing.

This is on by default for every agent that has `sandboxes`; there is no opt-out yet. Only files survive, not running processes. Anything a run writes to disk, secrets and tokens included, is in the thread's later sandboxes until the snapshot expires. A restored sandbox is created from the snapshot alone: the definition's `environment` and `secrets` are not applied to it, because the platform forbids them together with a snapshot (a platform ask), and a baked `skills.git()` source is not re-resolved on a restore, so a thread keeps its skills until its snapshot expires (`"boot"` sources are fetched again).

The `setup` hook of `sandbox()` still runs after a restore, and its context has an optional `restored` flag so it can skip work the snapshot already holds.
