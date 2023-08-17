# Parallel Reduce Example

This example demonstrates how to run multiple steps in parallel to accumulate a value using `Array.prototype.reduce`.

It is triggered by a `demo/parallel.reduce` event, runs three steps in parallel to fetch scores from a database, and accumulates the total of all of the scores.

```mermaid
graph TD
Inngest -->|demo/parallel.reduce| Function
Function -->|Run step| blue[Get blue team score]
Function -->|Run step| red[Get red team score]
Function -->|Run step| green[Get green team score]
blue & red & green --> total[Accumulate score]
total -->|Returns| done[150]
```
