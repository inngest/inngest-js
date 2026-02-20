# Logger Callsite Summary

All `getLogger()` / `this.logger` / `this.client.logger` callsites in `packages/inngest/src/`.

`getLogger()` uses AsyncLocalStorage to find the execution-context logger, falling back to a global/default logger. The question: can we remove the ALS dependency by piping the logger (from the client) directly to each callsite?

> **Important:** `client.logger` is currently a getter that calls `getLogger()`:
> ```ts
> get logger(): Logger {
>   return getLogger(); // ← uses ALS
> }
> ```
> The first step of any refactor is changing this getter to return a stored property instead.

---

## Logger Already Available

The client (and therefore its logger) is already in the function's scope. These sites either already use `this.logger` / `this.client.logger`, or use `getLogger()` but have the client right there.

| # | File | Line(s) | Access | Context |
|---|------|---------|--------|---------|
| 1 | `Inngest.ts` | 510 | `this.logger` | `warnMetadata()` — `this` is the client |
| 2 | `Inngest.ts` | 775 | `this.logger` | `_send()` entropy error |
| 3 | `Inngest.ts` | 828 | `this.logger` | `_send()` empty events warning |
| 4 | `Inngest.ts` | 981 | `logger` local var | `builtInMiddleware` LoggerMiddleware — `logger` starts as `baseLogger` but may be reassigned to a child logger (line 974) |
| 5 | `Inngest.ts` | 985 | `this.#proxyLogger` | LoggerMiddleware `onBeforeFunctionRun` — creates `ProxyLogger` instance |
| 6 | `Inngest.ts` | 990 | `this.#proxyLogger` | LoggerMiddleware `onBeforeFunctionRun` — injects into `ctx.logger` |
| 7 | `Inngest.ts` | 996 | `this.#proxyLogger` | LoggerMiddleware `onMemoizationEnd` — enables logging |
| 8 | `Inngest.ts` | 1000 | `this.#proxyLogger` | LoggerMiddleware `onStepError` |
| 9 | `Inngest.ts` | 1007 | `this.#proxyLogger` | LoggerMiddleware `wrapFunctionHandler` |
| 10 | `Inngest.ts` | 1013 | `this.#proxyLogger` | LoggerMiddleware `wrapRequest` — flushes logs |
| 11 | `InngestCommHandler.ts` | 451 | `this.client.logger` | Undefined functions warning in constructor |
| 12 | `InngestCommHandler.ts` | 512 | `this.client.logger` | Invalid streaming option |
| 13 | `InngestCommHandler.ts` | 554 | `warnOnce(this.client.logger, ...)` | INNGEST_SERVE_HOST deprecation |
| 14 | `InngestCommHandler.ts` | 631 | `warnOnce(this.client.logger, ...)` | INNGEST_STREAMING deprecation |
| 15 | `InngestCommHandler.ts` | 1414 | `this.client.logger` | Action handler error |
| 16 | `InngestCommHandler.ts` | 1520 | `this.client.logger` | Missing body on POST |
| 17 | `InngestCommHandler.ts` | 1573 | `this.client.logger` | Invalid step plan header |
| 18 | `InngestCommHandler.ts` | 1840 | `this.client.logger` | Execution result error |
| 19 | `InngestCommHandler.ts` | 1897 | `this.client.logger` | Missing body on PUT |
| 20 | `InngestCommHandler.ts` | 2160 | `this.client.logger` | Invalid function config |
| 21 | `InngestCommHandler.ts` | 2392 | `this.client.logger` | Registration error |
| 22 | `InngestCommHandler.ts` | 2410 | `this.client.logger` | Unparse register response |
| 23 | `InngestCommHandler.ts` | 2432 | `this.client.logger` | Invalid register response |
| 24 | `InngestCommHandler.ts` | 2453 | `this.client.logger` | Successful registration debug |
| 25 | `InngestMetadata.ts` | 298 | **`getLogger()`** | `performOp()` — first param is `client: Inngest`, so `client.logger` is right there |
| 26 | `InngestStepTools.ts` | 788 | **`getLogger()`** | `sleepUntil` matchOp — `client` is in closure from `createStepTools(client, ...)` |
| 27 | `connect/index.ts` | 533 | **`getLogger()`** | Connection limit error — `this.inngest` (the client) is on the class |

Rows 25–27 currently call `getLogger()` but could trivially switch to `client.logger` / `this.inngest.logger` with no signature changes.

---

## Logger Could Be Available

These callsites use `getLogger()` and the client is **not** in scope, but a logger could be passed in as a parameter with moderate refactoring.

### Easy — add a `logger` param to the function/constructor

| # | File | Line(s) | Function | How to pipe | Notes |
|---|------|---------|----------|-------------|-------|
| 1 | `middleware/manager.ts` | 338, 362, 414, 441, 460, 480, 501 | `MiddlewareManager` hook catch blocks (`onStepStart`, `onStepComplete`, `onStepError`, `onMemoizationEnd`, `onRunStart`, `onRunComplete`, `onRunError`) | Add `logger` to constructor; the engine already has the client when it creates this. | 7 callsites, all identical pattern |
| 2 | `middleware/utils.ts` | 112 | `stepKindFromOpCode()` | Add `logger` param; called from `MiddlewareManager.applyToStep()` which would have it from above. | 1 callsite |
| 3 | `helpers/functions.ts` | 245 | `fetchAllFnData()` | Add `logger` param; called from `InngestCommHandler` which has `this.client.logger`. | 1 callsite |
| 4 | `helpers/env.ts` | 360, 363 | `getFetch()` inner `customFetch` wrapper | Add `logger` to `getFetch()` and close over it. Called from `InngestCommHandler` constructor. | 2 callsites in one catch block |
| 5 | `helpers/net.ts` | 113, 125 | `signDataWithKey()` | Add `logger` param. Called from `InngestCommHandler` request verification. | 2 callsites |
| 6 | `helpers/ServerTiming.ts` | 39, 44 | `ServerTiming.start()` closure | Add `logger` to `ServerTiming` constructor. Created in `InngestCommHandler.handleAsyncRequest()` which has the client. | 2 callsites |

### Moderate — requires restructuring a module-level constant or factory

| # | File | Line(s) | Function | How to pipe | Notes |
|---|------|---------|----------|-------------|-------|
| 7 | `helpers/functions.ts` | 88, 99 | `versionSchema` Zod `.transform()` | The schema is a module-level `const`. Would need to become a factory (`createVersionSchema(logger)`) or `parseFnData` would need to inline the version parsing instead of using a shared schema. | 2 callsites in a Zod transform closure |
| 8 | `execution/otel/middleware.ts` | 96, 108, 122, 133 | `extendedTracesMiddleware()` factory body | These run at middleware factory call time — **before the client exists** (`new Inngest({ middleware: [extendedTracesMiddleware()] })`). Could (a) accept a `logger` param to the factory, or (b) defer to an `onRegister` hook which does receive client context. | 4 callsites |
| 9 | `execution/otel/util.ts` | 54, 79 | `extendProvider()` | Add `logger` param. Called from the OTel middleware factory (see #8), so same constraint applies. | 2 callsites |

---

## Logger Cannot Be Available

**None.** Every callsite can have a logger piped in with some refactoring. The hardest cases are:

- **`versionSchema`** (#7 above): Module-level Zod schema with a `.transform()` closure. Requires restructuring to a factory or inlining.
- **OTel middleware factory** (#8 above): Runs before the client is constructed, so the *client's* logger isn't available. But the factory could accept its own logger parameter, or defer setup to a middleware hook.

---

## Summary

| Category | Callsites | Using `getLogger()` |
|----------|-----------|---------------------|
| Already available | 27 | 3 (trivial fix) |
| Could be available (easy) | 15 | 15 |
| Could be available (moderate) | 8 | 8 |
| Cannot be available | 0 | 0 |
| **Total** | **50** | **26** |
