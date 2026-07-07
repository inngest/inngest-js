---
"inngest": feature
---

Report in-progress steps: in Checkpointing mode, a step running longer than 1s fires a fire-and-forget leading-edge `StepPlanned` checkpoint so the step can be shown as running; on completion a normal full-span `StepRun` supersedes it.
