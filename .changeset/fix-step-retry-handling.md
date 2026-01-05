---
"inngest": patch
---

Fix step retry handling for sync execution mode

- Only mark step errors as non-retriable on final attempt
- Re-run step function when cached error exists but retries remain
