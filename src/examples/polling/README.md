# Parallel Work Example

This example demonstrates how to run concurrent chains of work in the same step function to create a step that polls on a schedule, either returning a result or timing out.

It is triggered by a `demo/polling` event, and runs 2 separate chains of work in parallel: one for the timeout, and one for the poll. We declare this logic as a `poll()` function within the body of the step function.

```mermaid
graph TD
Inngest -->|demo/polling| Function

subgraph poll
timeout[["step.sleep('30s')"]]
timeout ------>|30s up|timeoutDone[Set timedOut=true]
api[["step.run('Check if external job complete')"]]
api --> check{Job returned data?}
check -->|No| timeoutCheck{timedOut==true?}
timeoutCheck -->|No| iterate["step.sleep('10s')"]
iterate -->|10s up|timeoutCheck2{timedOut==true?}
timeoutCheck2 -->|No|api
end

Function -->|Runs| poll

timeoutCheck2 --->|Yes|noJob[jobData = null]
check ------>|Yes| yesJob["jobData = {...}"]
timeoutCheck -->|Yes|noJob

yesJob -->|Runs|doData["step.run('Do something with data')"]
doData & noJob --> finish([End])
```
