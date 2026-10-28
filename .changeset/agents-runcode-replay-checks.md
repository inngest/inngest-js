---
"inngest": patch
---

A `run_code` script that runs again after a wait and ends having made fewer calls than before now fails with exit code 76, whichever way it exits, and the argument check ignores key order. A script's own failure exit code is no longer replaced, and the files a `run_code` replay leaves behind are removed even when the sandbox is going away.
