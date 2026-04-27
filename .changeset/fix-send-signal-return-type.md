---
"inngest": patch
---

Fix `step.sendSignal()` return type to match runtime: `Promise<InngestApi.SendSignalResponse>` (`{ runId: string | undefined }`) instead of `Promise<null>`
