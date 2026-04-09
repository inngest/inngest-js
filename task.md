# group.defer()

Defers a callback to a separate function run. Parent run sends `deferred.start` event; deferred run executes the callback.

## Behavior

- Handler context (`event`, `events`, `runId`) is identical in both parent and deferred runs
- Callback receives `{ runId }` — the deferred run's own run ID
- `deferred.start` trigger is auto-registered with an expression filter matching `fnSlug`
- Event schema validation is skipped for `deferred.start`
- Deprecated `user` field is stripped from all incoming events

## Open

- 1s sleep after sendEvent to prevent race (temporary)
- Single defer per function (multiple defers not yet supported)
- No return value from deferred callback
