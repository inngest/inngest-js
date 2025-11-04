# Step Metadata Support – SDK Plan

## Context & Goals

- Enable user-defined metadata updates from TypeScript SDK via `step.metadata.update(...)`.
- Metadata flows alongside existing execution payloads (augment responses) for execution versions **v1** and **v2** only; v0 remains unchanged.
- Respect two execution contexts:
  - **Inside a running step** (`step.run`, `step.ai.wrap`, etc.).
  - **Inside an Inngest function but outside any step**.
- Support targeting other runs/steps via REST fallback while defaulting to current run/step.
- Keep merging semantics **shallow** (latest call overwrites keys for the same scope).

## High-Level Approach

1. **Expose tooling** – add `metadata.update` to `createStepTools()` so `step.metadata.update` is available in userland. IntelliSense surfaces new helper via type exports.
2. **Accumulate metadata** – track pending metadata inside execution v1/v2 instances and flush it when emitting steps or final results.
3. **Augment responses** – carry metadata inside the JSON payloads we already return instead of defining new opcodes.
4. **Fallback to REST** – when a `target` is specified, issue an authenticated API call using a new helper (`InngestApi.updateMetadata`), allowing cross-run/step updates.
5. **Tests & typing** – extend step tool tests, executor tests, and typings while leaving v0 untouched.

## File Touchpoints & Key Changes

| Area | File(s) | Notes |
| --- | --- | --- |
| Types & enums | `packages/inngest/src/types.ts`, `packages/inngest/src/index.ts` | Add `MetadataTarget`, `MetadataOptsOrId`, optional `metadata` on `Op`/`OutgoingOp`, widen `ExecutionResult` envelopes, re-export types. |
| Step tooling | `packages/inngest/src/components/InngestStepTools.ts` | Inject `metadata.update`. Use `getAsyncCtx()` to branch behavior. Validate input, shallow merge, call execution helpers. |
| Execution state | `packages/inngest/src/components/execution/v1.ts`, `.../v2.ts` | Maintain `pendingStepMetadata` & `pendingRunMetadata`. Attach metadata when steps run and when returning results. Provide helper methods for the step tools. |
| Response serialization | `packages/inngest/src/components/InngestCommHandler.ts` | Adjust `steps-found`, `step-ran`, `function-resolved`, `function-rejected` handlers to include optional `metadata` when present (e.g., `stringify({ steps, metadata })`). |
| API helper | `packages/inngest/src/api/api.ts`, `packages/inngest/src/components/Inngest.ts` | Add `updateMetadata` REST helper and internal wrapper for step tools. |
| Tests | `packages/inngest/src/components/InngestStepTools.test.ts`, `packages/inngest/src/components/execution/*.test.ts` | Cover context detection, shallow merge, REST fallback, payload augmentation. |

## Implementation Notes (2025-11-03 code review)

- **Step tooling**: `createStepTools` in `packages/inngest/src/components/InngestStepTools.ts` builds the exported `tools` object (see the `const tools = { ... }` block around the existing `sendEvent`, `ai`, and `gateway` helpers). We can slot `metadata.update` alongside the other grouped helpers, reusing `createTool` so async context and memoization behaviour stay consistent. `getAsyncCtx()` (from `components/execution/als.ts`) already exposes `ctx.executingStep`; v1/v2 executions set this via `store.executingStep` inside `executeStep`, so the tool can branch on step vs run context without additional plumbing. When a `target` is provided we will bypass accumulation and call an internal client method (mirroring `_sendSignal`) that wraps the REST fallback.
- **Execution state hooks**: Both `V1InngestExecution` and `V2InngestExecution` (in `packages/inngest/src/components/execution/v1.ts` and `.../v2.ts`) manage per-run state via `this.state`. They already hash step IDs (`_internals.hashId`) and track the currently executing step (`this.state.executingStep`). We should extend the backing state with `pendingStepMetadata: Map<string, Record<string, unknown>>` keyed by hashed step IDs and a `pendingRunMetadata?: Record<string, unknown>`. Provide helpers such as `mergeStepMetadata`, `consumeStepMetadata`, `mergeRunMetadata`, and `consumeRunMetadata` so the step tool can push data and the execution paths can flush it safely. `executeStep`, `filterNewSteps` (when returning `steps-found`), and `transformOutput` (for `function-resolved`/`function-rejected`) are the choke points where we attach metadata to outgoing payloads; these should clear the pending buffers after use. Execution v0 should remain untouched.
- **Outgoing payload shape**: `ExecutionResults` in `packages/inngest/src/components/execution/InngestExecution.ts` and the downstream `ExecutionResultHandlers` in `packages/inngest/src/components/InngestCommHandler.ts` assume only `ctx`, `ops`, and the main payload. We will augment these types to allow an optional `metadata` object on `step-ran`, `steps-found`, `function-resolved`, and `function-rejected`. The comm handler’s `resultHandlers` currently call `stringify(step)` or `stringify(steps)`; we’ll wrap these in `{ step, metadata }` / `{ steps, metadata }` envelopes when metadata exists (using the existing `opDataUndefinedToNull` helper on the ops before serialization). For function-level responses we return `metadata` alongside the serialized `data`/`error` so Cloud can persist run-level updates.
- **Type exports**: `Op`/`OutgoingOp` in `packages/inngest/src/types.ts` define what the executor sees; they need a `metadata?: Record<string, unknown>` field. We’ll also introduce `MetadataTarget` and `MetadataOptsOrId` here and re-export them through `packages/inngest/src/index.ts` so userland code and tests can consume the types without deep imports. The `GetStepTools` helper will naturally pick up the new tool once `createStepTools` includes it, but we should verify TS inference in `InngestStepTools.test.ts` and update any helper typings (e.g., `packages/inngest/src/test/helpers.ts`) to surface the new API.
- **REST fallback plumbing**: `packages/inngest/src/api/api.ts` already exposes authenticated helpers like `sendSignal`. We can add `updateMetadata(target, metadata)` that POSTs to `/v1/metadata` using `fetchWithAuthFallback`, passing the hashed signing key. `packages/inngest/src/components/Inngest.ts` should mirror the private `_sendSignal` pattern with an `_updateMetadata` method that the tooling can reach via `client["_updateMetadata"]`. This keeps environment headers and auth consistent and enables reuse inside tests by stubbing `client.inngestApi`.
- **Async context guardrails**: `getAsyncCtx()` falls back to a noop async-local store when `node:async_hooks` is unavailable, so we should retain the current error messaging (“requires an Inngest function”) for unsupported runtimes. When no context exists we throw, matching `step.fetch`. Within a live step we’ll use the hashed ID (`ctx.executingStep?.id`) to merge metadata; outside a step but inside a function we instead accumulate run-level data.
- **Testing surfaces**: `packages/inngest/src/components/InngestStepTools.test.ts` already covers tool ergonomics and can assert: shallow merge behaviour, step vs run routing through the async context helpers, and REST fallback invocation (likely by spying on `client["_updateMetadata"]`). Execution assertions live in `packages/inngest/src/components/StepFailedResponse.test.ts` and related suites; we can extend them to confirm metadata propagation on both success and failure paths. Use `packages/inngest/src/test/helpers.ts` to build deterministic executions and inspect the returned `ExecutionResult`. Once implemented, run targeted suites such as `pnpm test --filter InngestStepTools.test.ts` and a representative execution integration (e.g., `pnpm test --filter StepFailedResponse.test.ts`) before the broader test matrix.

## Behavior Matrix (inside `metadata.update`)

- **Inside executing step** (async context present, `ctx.executingStep` defined): merge metadata into accumulator keyed by current step id.
- **Inside function, not in step**: merge metadata into run-level accumulator.
- **Any context with `target` provided**: call new REST helper immediately (optionally wrap via `step.run` if later durability required).
- **Outside Inngest function**: throw (mirrors `step.fetch` behavior).

Shallow merge via `Object.assign` to keep semantics predictable.

## Snippet Pointers (Illustrative Only)

- **Tool registration** (`InngestStepTools.ts`):
  ```ts
  const tools = {
    ...,
    metadata: {
      update: createTool<MetadataUpdateFn>(...(args) => {
        const ctx = await getAsyncCtx();
        if (!ctx) throw new Error("step.metadata.update requires an Inngest function");
        // branch on ctx.executingStep & target
      }),
    },
  };
  ```

- **Execution accumulators** (`execution/v2.ts`, mirrored in v1):
  ```ts
  private pendingStepMetadata = new Map<string, Record<string, unknown>>();
  private pendingRunMetadata: Record<string, unknown> | undefined;

  public mergeStepMetadata(id: string, metadata: Record<string, unknown>) {
    const current = this.pendingStepMetadata.get(id) ?? {};
    this.pendingStepMetadata.set(id, { ...current, ...metadata });
  }
  ```

- **Augment outgoing op** (`executeStep`):
  ```ts
  const metadata = this.consumeStepMetadata(id);
  const outgoingOp: OutgoingOp = {
    ...,
    ...(metadata ? { metadata } : {}),
  };
  ```

- **Serialize response with metadata** (`InngestCommHandler.ts`):
  ```ts
  "steps-found": (result) => {
    const body = stringify({ steps, ...(result.metadata ? { metadata: result.metadata } : {}) });
    return { status: 206, headers, body, version };
  };
  ```

- **REST helper skeleton** (`api/api.ts`):
  ```ts
  async updateMetadata(target: MetadataTarget, metadata: Record<string, unknown>) {
    return fetchWithAuthFallback({
      url: await this.getTargetUrl("/v1/metadata"),
      options: { method: "POST", body: JSON.stringify({ target, metadata }) },
      authToken: this.hashedKey,
    });
  }
  ```

## Testing Checklist

- `packages/inngest/src/components/InngestStepTools.test.ts` – add cases for async-context validation, shallow merge semantics, and REST fallback (spy on `client["_updateMetadata"]`).
- `packages/inngest/src/components/StepFailedResponse.test.ts` (and related execution assertions) – extend to inspect `result.metadata` for both success and failure returns.
- `packages/inngest/src/test/helpers.ts` – ensure helpers expose the new tool so tests can drive execution metadata.
- Manual smoke: run `pnpm test --filter InngestStepTools.test.ts` and `pnpm test --filter StepFailedResponse.test.ts`; follow up with the executor-focused suites once metadata wiring is in place.

## Key Decisions & Rationale

- **Augment existing responses** rather than invent a new opcode – keeps executor/back-end contract simple while you add server-side parsing for optional `metadata` fields.
- **v1/v2 only** – ensures deterministic behavior for modern executions without touching legacy v0.
- **Shallow merge** – predictable overwrites and aligns with user expectations for metadata bags.
- **Optional REST fallback** – supports cross-run targeting without reinventing durable orchestration.
- **No explicit size enforcement** – rely on existing payload limits; keep implementation simple.

---

## Implementation Status (2025-11-04)

- **Step tooling**: `step.metadata.update` implemented in `createStepTools`. Defaults to accumulating metadata against the active step or run via ALS; falls back to REST helper when a `target` is provided.
- **Execution plumbing**: Execution v1/v2 maintain pending run/step metadata queues, flush metadata alongside `steps-found`, `step-ran`, and final results. Legacy v0 untouched.
- **Comm handler**: Response serialization now attaches metadata envelopes while preserving legacy payload shapes for downstream consumers.
- **REST helper**: `InngestApi.updateMetadata` and `Inngest._updateMetadata` added and consumed by the tooling fallback path.
- **Tests**:
  - Added unit coverage in `InngestStepTools.test.ts` for ALS routing, shallow merge behaviour, and REST delegation.
  - Added execution-level propagation tests in `components/execution/metadata.test.ts`.
  - Full SDK suite (`pnpm test -- --runInBand` from `/packages/inngest`) now passes, confirming framework handlers and metadata envelopes are aligned.

---

This document captures the agreed context, scope, and technical plan for delivering `step.metadata.update` within the TypeScript SDK.

