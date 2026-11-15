---
"inngest": patch
---

Fix a memory leak in `InngestSpanProcessor` where root span IDs added to the internal checkpointing set during step execution were never removed, growing by one entry per execution for the life of the process. They are now cleaned up when the root span ends.
