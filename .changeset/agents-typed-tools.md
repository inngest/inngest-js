---
"inngest": patch
---

`AgentLoopOptions`, `AgentLoopResult` and `AgentToolRun` take the tools as a type argument, defaulting to untyped. `tool()`, `tool.step()` and `tool.group()` now keep the types of their `input` and `output` schemas, and `agent.loop()` carries them to `onToolResult` and `toolCalls`. Every run also has a `name`, the same as `call.name`. Once `run.isError` is false, checking `run.name` types `run.call.input` and `run.output` for that tool. Declare the variable you pass back as `history` as `let history: AgentMessage[] = []`; typing it as `AgentMessage[] | undefined` makes TypeScript report a circular type when you assign `result.history` to it.
