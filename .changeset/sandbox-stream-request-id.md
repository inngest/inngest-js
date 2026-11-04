---
"inngest": patch
---

Fix `SandboxError.requestId` being `undefined` for errors from Sandbox process and log output streams. The request ID was set on `snapshotId` instead.
