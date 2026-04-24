---
"inngest": minor
---

connect: verbose shutdown diagnostics for stuck in-flight requests

During a graceful drain the SDK now emits a `debug`-level `"Shutdown: still draining in-flight request"` line for each pending request — at drain start and periodically thereafter — including `requestId`, `runId`, `stepId`, `functionSlug`, `ageMs`, and `sinceLastLeaseExtendMs`. Makes it straightforward to identify which run is blocking a shutdown when the worker sits with only heartbeat logs after visible work has finished.

To avoid log spam at high concurrency the per-request dump is only used when `inFlightCount <= shutdownInFlightDumpMaxCount` (default `10`); above the threshold a single summary line is logged instead. Both the threshold and the periodic cadence are configurable via the new `ConnectHandlerOptions` fields:

- `shutdownInFlightDumpMaxCount` — default `10`, set `0` to always use the summary form.
- `shutdownInFlightDumpIntervalMs` — default `10000`.

The existing `"Extending lease"` debug log now also includes `requestId`, `functionSlug`, `runId`, and `stepId`. No `info`/`warn` logs change; all new output is `debug`-level only.
