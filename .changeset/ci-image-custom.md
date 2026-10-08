---
"@inngest/ci": minor
---

Jobs can start from a sandbox you captured under a name: `ci.job({ id: "test", from: image.custom("agent-deps") }, …)`, or `createCi(inngest, { from: image.custom("agent-deps") })` for every job without its own `from`. Capture one with `sandbox.snapshot({ name: "agent-deps" })`.
