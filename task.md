# group.defer()

Defers a callback to a separate function run. Parent run reports a `DeferGroup` opcode; the Dev Server persists the intent in run metadata and emits `inngest/deferred.start` after the parent completes via `finalizeEvents`. The deferred run executes the callback.

## Behavior

- Handler context (`event`, `events`, `runId`) is identical in both parent and deferred runs
- Callback receives `{ runId }` — the deferred run's own run ID
- `DeferGroup` opcode carries `fnSlug` in `opts` so the Dev Server knows which function to defer
- `inngest/deferred.start` trigger is NOT auto-registered; the Dev Server routes via `fnSlug` lookup
- Event schema validation is skipped for `inngest/deferred.start`
- Deprecated `user` field is stripped from all incoming events (SDK) and embedded events (Go)

## SDK opcode

The `DeferGroup` opcode is a sync step with:
- `op: "DeferGroup"`
- `mode: "sync"`
- `opts.fnSlug`: the fully-qualified function slug
- `fn`: no-op (returns null)
- Step ID: `"defer"`

## Dev Server handling

When the executor sees `DeferGroup`:
1. Save the step output (like `StepRun`)
2. Persist `fnSlug` in run metadata via `UpdateMetadata` (`deferFnSlug` field)
3. Enqueue next discovery step so the parent continues

When the parent run completes (`finalizeEvents`):
4. Check `opts.Metadata.Config.DeferGroupFnSlug`
5. If set, embed original events, step state, runId, and fnSlug in `inngest/deferred.start` event data
6. The runner's `FindDeferredFunction` matches by `fnSlug`, extracts embedded steps, and starts the deferred run

State is embedded directly in the `inngest/deferred.start` event because the parent run's state may be deleted before the runner processes the event.

## Open

- Single defer per function (multiple defers not yet supported)
- No return value from deferred callback
- V0 execution version warning on deferred runs (non-fatal, treated as "SDK decides")
