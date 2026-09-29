---
"inngest": patch
---

Fix realtime subscriptions throwing `Cannot access 'stream' before initialization` when a `datastream-start` message arrives, which dropped all streamed chunks
