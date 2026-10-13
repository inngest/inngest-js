---
"inngest": minor
---

Step options accept `metadata: { kind, values }`, so steps the SDK creates, such as `step.sandbox.*` and `step.invoke`, can carry step metadata. `values` is a record, or a function of the step's result or error that runs inside the step.
