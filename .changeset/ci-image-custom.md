---
"@inngest/ci": minor
---

Jobs can start from a sandbox you captured under a name: `ci.job({ id: "test", from: image.snapshot("agent-deps") }, …)`, or `createCi(inngest, { from: image.snapshot("agent-deps") })` for every job without its own `from`. Capture one with `sandbox.snapshot({ name: "agent-deps" })`.
