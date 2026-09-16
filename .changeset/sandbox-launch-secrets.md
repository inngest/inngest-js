---
"inngest": minor
---

Add `secrets` to sandbox create options to map environment variable names to workspace secret names, for example `secrets: { OPENAI_API_KEY: "openai-production" }`. Names resolve to secret identities at creation, including across create retries. Values are fetched at launch and inherited by commands, managed processes, and snapshots.
