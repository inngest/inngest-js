---
"inngest": patch
---

Fix errant `step.sendSignal` "Unknown step type" warning. Middleware now sees `stepType: "sendSignal"` instead of `"unknown"`.
