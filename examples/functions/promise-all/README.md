# Promise.all Example

This example demonstrates using `Promise.all()` to wait for concurrent chains of work to resolve before continuing; all step tooling returns a promise, so any pattern using async JavaScript is supported.

It is triggered by a `demo/promise.all` event, and runs 2 separate steps in parallel. Once both are complete, Step 3 runs and adds the result of both.

```mermaid
graph TD
Inngest -->|demo/promise.all| Function

Function --> step1["steps.run('Step 1')"]
Function --> step2["steps.run('Step 2')"]
step1 & step2 --> step3["steps.run('Step 3')"]
step3 --> ret["3"]
```
