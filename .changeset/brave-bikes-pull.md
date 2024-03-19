---
"inngest": patch
---

INN-2861 No longer execute `step.sendEvent()` inline

To send an event in a function without making it a step function, use `inngest.send()` instead.
