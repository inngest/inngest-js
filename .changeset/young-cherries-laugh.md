---
"inngest": patch
---

Connect now sets the connection state to `CLOSING` while handling and flushing any pending messages instead of immediately going to `CLOSED`
