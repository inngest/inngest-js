---
"inngest": minor
---

Experimental agents: `keepAlive: { idle }` on a sandbox binding is accepted and marked `@deprecated`. It does nothing yet: stopping an idle sandbox needs an idle timeout on the platform's sandbox, which does not exist, so a sandbox with `keepAlive` is snapshotted and destroyed at run end like any other and restored by the thread's next run.
