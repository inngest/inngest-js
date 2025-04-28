---
"@inngest/realtime": patch
---

Fix throw of `TypeError: Failed to execute 'cancel' on 'ReadableStream': Cannot cancel a locked stream` when unmounting or cancelling a stream utilizing the callback feature
