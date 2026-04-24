---
"inngest": minor
---

connect: verbose shutdown diagnostics for stuck in-flight requests

During a graceful drain the SDK now emits a `debug`-level summary line (`"Shutdown: still draining"` with `inFlightCount` + `oldestAgeMs`) plus one `"Shutdown: still draining in-flight request"` line per pending request — at drain start and every 10s thereafter. Each per-request line carries `requestId`, `runId`, `stepId`, `functionSlug`, `appId`, `ageMs`, and `sinceLastLeaseExtendMs`, so it's obvious which run is holding the shutdown when the worker otherwise sits quiet with only heartbeat logs.

The existing `"Extending lease"` debug log now also includes `requestId`, `functionSlug`, `runId`, and `stepId`. No `info`/`warn` logs change — all new output is at `debug` level, so normal operational logs are unchanged.

No new public options.
