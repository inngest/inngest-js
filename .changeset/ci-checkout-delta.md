---
"@inngest/ci": minor
---

Local runs are faster: `checkout()` now uploads only what changed since the machine's last working tree and updates an existing checkout in place instead of cloning again.
