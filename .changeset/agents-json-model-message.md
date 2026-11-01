---
"inngest": patch
---

`inngest/experimental/agents` exports `Json`, the type of anything JSON can carry, and `JsonSchema`, a JSON Schema document. `KvJson` is now the same type as `Json`, so an object property of `undefined` no longer type-checks as a `KvJson`, and a `KvJson` list is no longer `readonly`. The loop's message type `AgentMessage` is renamed `ModelMessage`; change your imports and annotations such as `let history: ModelMessage[] = []`.
