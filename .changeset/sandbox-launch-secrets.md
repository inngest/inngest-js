---
"inngest": minor
---

Add `secrets` to sandbox create options as an array of exact workspace secret names, for example `secrets: ["OPENAI_API_KEY"]`. Save each secret under the environment variable name the application expects. Duplicate names and collisions with literal environment variables are rejected. Names resolve to secret identities at creation, including across create retries. Values are fetched at launch and inherited by commands, managed processes, and snapshots.
