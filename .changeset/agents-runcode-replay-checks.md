---
"inngest": patch
---

A `run_code` script that runs again after a wait, exits 0 and has made fewer calls than before now fails with exit code 76, even when it ends with `os._exit(0)`, and the argument check ignores key order. Only exit code 0 is checked, so a script's own failure code is kept, and the files a `run_code` replay leaves behind are removed even when the sandbox is going away.
