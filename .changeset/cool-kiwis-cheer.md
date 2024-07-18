---
"inngest": patch
---

Do not allow objectish `[]` for an event's `data` when providing schemas

This helps solve an issue whereby types would be happy but sending an event fails at runtime.
