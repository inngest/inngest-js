---
"inngest": minor
---

`sandbox.tools.code({ tools })` now adds `run_code`, which runs a Python or TypeScript script that can call your tools and wait for as long as it likes. Declare a tool with `tool.group({ waits: true })` and the script exits while the tool waits, then runs again from the top with its earlier calls answered from a journal. `tools.sleep({ duration })` and `tools.now()` are built in.

```ts
tools: sandbox.tools.code({ only: ["run_code"], tools: { approve } })
```
