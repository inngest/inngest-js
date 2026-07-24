---
"inngest": patch
---

fix(middleware): map `step.ai.wrap` planned op to `ai.wrap` step type

`step.ai.wrap()` emits a `StepPlanned` op with `opts.type === "step.ai.wrap"`,
but `stepTypeFromOpCode` only recognised `step.ai.wrap` under the
`AiGateway` opcode branch. Normal `step.ai.wrap()` usage therefore fell
through to `unknown` and logged an "Unknown step type" warning.

Adds the missing `step.ai.wrap` case to the `StepPlanned` branch so
middleware step-type metadata is correct and the warning no longer fires.
The existing `AiGateway` mapping is preserved.
