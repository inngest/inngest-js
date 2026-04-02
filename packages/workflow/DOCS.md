# @inngest/workflow

A wrapper for executing Inngest workflow functions locally without an HTTP server.  The wrapper runs a workflow handler through the Inngest execution engine and reports all results as `OutgoingOp[]` opcodes via a single `onResult` callback.

## Quick Start

```typescript
import { run, readInput, writeOutput } from "@inngest/workflow";
import type { WorkflowHandler } from "@inngest/workflow";

export const handler: WorkflowHandler = async ({ step, event }) => {
  const user = await step.run("fetch-user", () => getUser(event.data.userId));
  await step.sleep("cooldown", "1h");
  await step.run("send-email", () => sendEmail(user.email));
  return { sent: true };
};

const input = await readInput("/tmp/input");

await run(handler, {
  input,
  onResult: async (ops) => {
    await writeOutput(ops, "/tmp/output");
  },
});
```

## Execution Model

Each call to `run()` is **single-shot**: it reads input, executes one pass of the workflow, and returns the resulting opcodes.  The external orchestrator is responsible for driving the loop:

1. Call with empty `state` — get discovered step opcodes
2. Process the opcodes (execute steps, wait for sleeps, etc.)
3. Call again with completed steps in `state` — get the next batch or a terminal result

## Input Format

The `WorkflowInput` object describes the current execution state:

```typescript
interface WorkflowInput {
  event: EventPayload;          // the triggering event (any name)
  events?: EventPayload[];      // batch events (defaults to [event])
  state: Record<string, {   // completed steps keyed by hashed ID
    id: string;
    data?: unknown;
    error?: unknown;
  }>;
  stack: string[]; // hashed IDs in completion order
  runId: string;                 // unique execution ID
  attempt: number;               // retry attempt (zero-indexed)
  plannedStep?: string;     // target a specific step to execute
}
```

Use `readInput(path?)` to load this from a JSON file (defaults to `/tmp/input`).

## Opcodes Reference

Every execution result is delivered as `OutgoingOp[]` to the `onResult` callback.  The `op` field on each object tells you what happened.  Key fields on each `OutgoingOp`:

| Field         | Description                                              |
|---------------|----------------------------------------------------------|
| `id`          | Hashed step identifier                                   |
| `op`          | The opcode (see sections below)                          |
| `displayName` | Human-readable step name provided by the user            |
| `name`        | Opcode-specific value (e.g. sleep target timestamp)      |
| `data`        | Step return value (when completed successfully)          |
| `error`       | Error details (when the step or function failed)         |
| `opts`        | Opcode-specific options (match expressions, URLs, etc.)  |
| `userland`    | `{ id: string; index?: number }` — the unhashed step ID |

---

## Handling Single Step Results

When the workflow contains a single step, `onResult` receives an array with one `StepPlanned` opcode on the first pass.  After you provide the step result in `state`, the next pass resolves the function.

```typescript
// Workflow
const handler: WorkflowHandler = async ({ step }) => {
  const result = await step.run("process", () => compute());
  return result;
};

// First execution — step discovered
await run(handler, {
  input: { event, state: {}, stack: [], runId: "r1", attempt: 0 },
  onResult: (ops) => {
    // ops = [{ id: "abc123", op: "StepPlanned", displayName: "process", ... }]
  },
});

// Second execution — provide the step result, function completes
await run(handler, {
  input: {
    event,
    state: { "abc123": { id: "abc123", data: 42 } },
    stack: ["abc123"],
    runId: "r1",
    attempt: 0,
  },
  onResult: (ops) => {
    // ops = [{ id: "complete", op: "RunComplete", data: 42 }]
  },
});
```

---

## Handling Parallel Steps

When the workflow discovers multiple steps before any of them block execution, all are returned together in a single `onResult` call.  Each op is independent — the orchestrator can execute them in parallel.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  const [user, orders] = await Promise.all([
    step.run("fetch-user", () => getUser(id)),
    step.run("fetch-orders", () => getOrders(id)),
  ]);
  return { user, orders };
};

// First execution — both steps discovered at once
await run(handler, {
  input: { event, state: {}, stack: [], runId: "r1", attempt: 0 },
  onResult: (ops) => {
    // ops = [
    //   { id: "aaa", op: "StepPlanned", displayName: "fetch-user" },
    //   { id: "bbb", op: "StepPlanned", displayName: "fetch-orders" },
    // ]
    //
    // Execute both in parallel, then provide both results in the next call.
  },
});
```

### Planned steps after sequential dependencies

If steps are sequential, only the first unresolved step is discovered per pass:

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  const user = await step.run("fetch-user", () => getUser(id));
  // This step is only discovered once "fetch-user" is in state:
  await step.run("send-email", () => sendEmail(user.email));
};
```

Pass 1 returns `[{ op: "StepPlanned", displayName: "fetch-user" }]`.
Pass 2 (with `fetch-user` in `state`) returns `[{ op: "StepPlanned", displayName: "send-email" }]`.
Pass 3 (with both in `state`) returns `[{ op: "RunComplete" }]`.

---

## Handling Sleep

`step.sleep()` and `step.sleepUntil()` produce a `Sleep` opcode.  The `name` field contains the target wake-up timestamp as an ISO 8601 string.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  await step.sleep("wait-1h", "1h");
  await step.run("after-sleep", () => doWork());
};

// First execution
onResult: (ops) => {
  // ops = [{ id: "xyz", op: "Sleep", displayName: "wait-1h", name: "2026-04-02T16:00:00.000Z" }]
  //
  // The orchestrator should wait until the timestamp, then provide this
  // step in state with no data (just { id: "xyz" }) on the next call.
}
```

---

## Handling WaitForEvent

`step.waitForEvent()` produces a `WaitForEvent` opcode.  The `name` field is the event name to wait for, and `opts` contains the match expression and timeout.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  const activation = await step.waitForEvent("wait-activate", {
    event: "user/activated",
    match: "data.userId",
    timeout: "7d",
  });
  // activation is the event payload, or null if timed out
};

onResult: (ops) => {
  // ops = [{
  //   id: "...",
  //   op: "WaitForEvent",
  //   displayName: "wait-activate",
  //   name: "user/activated",
  //   opts: { match: "data.userId", timeout: "7d" }
  // }]
}
```

---

## Handling Fetch (Gateway)

`step.fetch()` produces a `Gateway` opcode with the URL, method, headers, and body in `opts`.  The orchestrator should perform the HTTP request and provide the response as step data.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  const response = await step.fetch("https://api.example.com/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "test" }),
  });
  return response.json();
};

onResult: (ops) => {
  // ops = [{
  //   id: "...",
  //   op: "Gateway",
  //   opts: {
  //     url: "https://api.example.com/data",
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: '{"query":"test"}'
  //   }
  // }]
}
```

---

## Handling Invoke

`step.invoke()` produces an `InvokeFunction` opcode.  The orchestrator should invoke the referenced function and return its result.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  const result = await step.invoke("call-other", {
    function: otherFunction,
    data: { key: "value" },
  });
};

onResult: (ops) => {
  // ops = [{
  //   id: "...",
  //   op: "InvokeFunction",
  //   displayName: "call-other",
  //   opts: { function_id: "...", payload: { data: { key: "value" } } }
  // }]
}
```

---

## Handling Step Errors (Retriable)

When a step throws a regular `Error`, the execution engine treats it as retriable.  The `onResult` callback receives a `StepError` opcode.  The orchestrator should retry the execution (incrementing `attempt`).

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  await step.run("flaky-api", async () => {
    const res = await fetch("https://api.example.com");
    if (!res.ok) throw new Error("API failed");
    return res.json();
  });
};

onResult: (ops) => {
  // ops = [{
  //   id: "error",
  //   op: "StepError",
  //   error: {
  //     name: "Error",
  //     message: "API failed",
  //     stack: "...",
  //     __serialized: true
  //   }
  // }]
  //
  // The orchestrator should retry with attempt: attempt + 1
}
```

---

## Handling RetryAfterError

When a step throws `RetryAfterError`, the opcode is `StepError` with `opts.retryAfter` set to the requested delay.  The orchestrator should wait for the specified duration before retrying.

```typescript
import { RetryAfterError } from "inngest";

const handler: WorkflowHandler = async ({ step }) => {
  await step.run("rate-limited-api", async () => {
    const res = await fetch("https://api.example.com");
    if (res.status === 429) {
      throw new RetryAfterError("Rate limited", "30s");
    }
    return res.json();
  });
};

onResult: (ops) => {
  // ops = [{
  //   id: "error",
  //   op: "StepError",
  //   error: {
  //     name: "RetryAfterError",
  //     message: "Rate limited",
  //     ...
  //   },
  //   opts: { retryAfter: "30s" }
  // }]
  //
  // Wait 30 seconds, then retry with attempt: attempt + 1
}
```

---

## Handling Non-Retriable Failures (StepFailed)

When a step throws `NonRetriableError`, the opcode is `StepFailed`.  The orchestrator must **not** retry.

```typescript
import { NonRetriableError } from "inngest";

const handler: WorkflowHandler = async ({ step }) => {
  await step.run("validate", async () => {
    if (!isValid(data)) {
      throw new NonRetriableError("Invalid input, will never succeed");
    }
  });
};

onResult: (ops) => {
  // ops = [{
  //   id: "error",
  //   op: "StepFailed",
  //   error: {
  //     name: "NonRetriableError",
  //     message: "Invalid input, will never succeed",
  //     ...
  //   }
  // }]
  //
  // Do NOT retry. The workflow has permanently failed.
}
```

---

## Handling Step Errors with try/catch

Users can catch step errors within the workflow using try/catch.  When a step fails and the user catches it, execution continues — the error does **not** propagate to `onResult`.  Instead, the orchestrator sees the subsequent steps or completion.

```typescript
const handler: WorkflowHandler = async ({ step }) => {
  let result;
  try {
    result = await step.run("risky-step", () => riskyOperation());
  } catch (err) {
    // Step failed, but we handle it gracefully
    result = await step.run("fallback", () => fallbackOperation());
  }
  return result;
};

// If "risky-step" was provided in state with an error:
// state: { "abc": { id: "abc", error: { message: "failed" } } }
//
// The workflow catches it and discovers "fallback":
// onResult: ops = [{ op: "StepPlanned", displayName: "fallback" }]
```

To provide a failed step result, set `error` instead of `data` in `state`:

```json
{
  "state": {
    "abc123": {
      "id": "abc123",
      "error": {
        "name": "Error",
        "message": "Something went wrong"
      }
    }
  }
}
```

---

## Function Completion (RunComplete)

When the workflow handler returns successfully, `onResult` receives a single `RunComplete` opcode with the return value in `data`.

```typescript
const handler: WorkflowHandler = async ({ step, event }) => {
  const user = await step.run("get-user", () => getUser(event.data.id));
  return { userId: user.id, processed: true };
};

// After all steps are in state:
onResult: (ops) => {
  // ops = [{
  //   id: "complete",
  //   op: "RunComplete",
  //   data: { userId: "u_123", processed: true }
  // }]
  //
  // The workflow is finished. No more calls needed.
}
```

---

## Function Failure

When the workflow handler throws an unhandled error (not inside a step), `onResult` receives either `StepError` or `StepFailed` depending on the error type:

```typescript
// Retriable failure (regular Error)
const handler: WorkflowHandler = async () => {
  throw new Error("Something broke");
};
// onResult: [{ id: "error", op: "StepError", error: { message: "Something broke", ... } }]

// Non-retriable failure (NonRetriableError)
const handler: WorkflowHandler = async () => {
  throw new NonRetriableError("Bad request");
};
// onResult: [{ id: "error", op: "StepFailed", error: { message: "Bad request", ... } }]

// Retry after specific duration
const handler: WorkflowHandler = async () => {
  throw new RetryAfterError("Slow down", "1m");
};
// onResult: [{ id: "error", op: "StepError", error: { ... }, opts: { retryAfter: "1m" } }]
```

---

## Opcode Summary

| Opcode           | Meaning                                   | Action                                      |
|------------------|-------------------------------------------|----------------------------------------------|
| `StepPlanned`    | Step discovered, needs execution          | Execute step, provide result in `state`  |
| `Sleep`          | Durable sleep requested                   | Wait until `name` timestamp, then continue   |
| `WaitForEvent`   | Waiting for external event                | Wait for matching event or timeout           |
| `WaitForSignal`  | Waiting for manual signal                 | Wait for signal or timeout                   |
| `InvokeFunction` | Invoke another Inngest function           | Call the function, return its result         |
| `Gateway`        | HTTP fetch via gateway                    | Perform the request, return response         |
| `AIGateway`      | AI model inference via gateway            | Run inference, return model output           |
| `StepRun`        | Step executed (result in `data`)          | Already complete, store in `state`       |
| `RunComplete`    | Workflow finished successfully            | Done. `data` has the return value            |
| `StepError`      | Retriable error                           | Retry (check `opts.retryAfter` for delay)    |
| `StepFailed`     | Non-retriable error                       | Permanent failure. Do not retry              |

---

## Step Tool Filtering

Restrict which step tools are available to the handler using `allowedStepTools`:

```typescript
await run(handler, {
  input,
  allowedStepTools: ["run", "sleep"],
  onResult: (ops) => { /* ... */ },
});
```

If the handler calls a disallowed tool, it throws a `NonRetriableError` and `onResult` receives a `StepFailed` opcode:

```
Step tool "invoke" is not available in this workflow. Allowed: run, sleep
```

Available tool names: `run`, `sleep`, `sleepUntil`, `waitForEvent`, `waitForSignal`, `sendEvent`, `sendSignal`, `invoke`, `ai`, `realtime`, `fetch`.
