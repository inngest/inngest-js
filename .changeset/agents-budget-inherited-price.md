---
"inngest": patch
---

An agent that has a dollar budget (`limits.budget.usd`) but no `limits.price` now fails its run with a `NonRetriableError` when it starts, including when the budget was inherited from the agent that started it, instead of counting its calls as free. A stored model-step cost that is not a finite number from 0 up is ignored and the call is priced again. A `match` key of `inbox_listen` may be at most 128 characters.
