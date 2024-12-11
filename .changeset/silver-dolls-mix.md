---
"inngest": minor
---

Add experimental `getAsyncCtx()`, allowing the retrieval of a run's input (`event`, `step`, `runId`, etc) from the relevant async chain.

```ts
import { getAsyncCtx } from "inngest/experimental";

const ctx = await getAsyncCtx();
```
