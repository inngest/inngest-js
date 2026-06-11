---
"inngest": patch
---

Avoid re-applying the default JSON output transform for middleware stacks where every middleware uses the default transform, preserving nested `step.run()` and function output inference with multiple default middlewares.
