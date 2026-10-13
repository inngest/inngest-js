---
"inngest": patch
---

Experimental: `step.sandbox.create()` now returns a sandbox you can declare with `await using`. The sandbox is destroyed, in a memoized `<id>:destroy` step, when the scope ends, including a `{ }` block, and only once however often the function replays. Without `using`, nothing changes. Destroying a sandbox that is already gone now succeeds instead of failing the step.
