---
"inngest": patch
---

Middleware now runs like onion layers. For example `{ middleware: [foo, bar] }` now runs:

- `foo.transformInput`
- `bar.transformInput`
- `foo.beforeMemoization`
- `bar.beforeMemoization`
- `bar.afterMemoization`
- `foo.afterMemoization`
- `foo.beforeExecution`
- `bar.beforeExecution`
- `bar.afterExecution`
- `foo.afterExecution`
- `bar.transformOutput`
- `foo.transformOutput`
- `foo finished`
- `bar finished`
- `foo beforeResponse`
- `bar beforeResponse`

This should enable middleware to behave correctly when it has to wrap other middleware.
