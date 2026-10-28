---
"inngest": minor
---

Experimental agents: the `keepAlive: { idle }` option of a sandbox binding is accepted and wired to the thread's sandbox owner, and is marked `@deprecated`: keeping a sandbox running between runs and stopping it after the idle time needs an idle timeout on the platform's sandbox, which does not exist yet (platform ask). Until it does, a sandbox with `keepAlive` behaves like any other: it is snapshotted and destroyed at run end and restored by the thread's next run.
