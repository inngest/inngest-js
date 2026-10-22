---
"inngest": patch
---

`await using` on a sandbox and `group.sandbox()` now always destroy the sandbox when their scope ends, and an error thrown after that is not retried, since a retry couldn't use the destroyed sandbox. Before, `await using` destroyed the sandbox on an error that was then retried, and `group.sandbox()` read the attempt count to decide.
