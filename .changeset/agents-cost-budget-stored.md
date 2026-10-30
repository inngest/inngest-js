---
"inngest": patch
---

A model call's cost for `limits.budget.usd` is now worked out once, inside the call's step, and stored with its result, so a replay uses the cost the call had and `limits.price` no longer needs to be pure. A `limits.price` table with no rate for the model, or a price that is not dollars from 0 up, stops the run with a `NonRetriableError` instead of retrying. An agent that sets `limits.budget.usd` without `limits.price` now throws when it is defined, instead of never spending the budget.
