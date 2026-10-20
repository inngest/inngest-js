# cli

The `inngest-ci` command. `main.ts` is the bin (citty); `run.ts` is the whole flow. Prompts come from `@clack/prompts`, the live view from `log-update`, free ports from `get-port`, process trees from `tree-kill`.

- `main.ts`: arguments and exit code (`0` passed, `1` failed or cancelled, `2` setup error). Unknown `--<axis> <value>` options are matrix axes. No shebang: tsdown adds it.
- `run.ts`: resolve config (guided setup at a terminal), boot, choose a target, send its event, watch the run, cancel strays, stop everything.
- `config.ts`: finds the project root and validates the `ci` key of `inngest.json`, with the `ci/server.*` convention as fallback.
- `setup.ts`: the guided setup prompts that write the `ci` key.
- `devServer.ts`: starts an isolated Dev Server (own ports, `--no-discovery`, no `INNGEST_*` env) and makes the REST calls the CLI needs.
- `app.ts`: starts the app with the CLI's env and waits for the sync and the manifest.
- `processes.ts`: child processes with log files, env scrubbing, stopping a whole tree.
- `reporterServer.ts`: loopback server for the app's `LocalMessage`s (`../local/protocol.ts`).
- `target.ts`: lists targets from the manifest, picks matrix combinations, builds the trigger or run-job event.
- `live.ts`: redraws the frame in place while a terminal is attached, one plain line per event otherwise.
- `liveFrame.ts`: the pure part of the live view. `apply` folds the app's messages into a state and `frame` draws it as a tree of jobs (matrix cells grouped, each running job's command and time, failures with the end of their output):

```
⠙ pr  http://127.0.0.1:44807/run?runID=...
└─ ✓ base                       31s
   ├─ ✓ lint                    44s
   ├─ ✓ typecheck               44s
   └─ ⠙ compat                  44s
      ├─ ⠙ node:22  $ npm test  44s
      └─ ⠙ node:24  $ npm test  44s
```
- `strays.ts`: cancels runs still going on the way out and waits a bounded time for their cleanup, so Sandboxes don't leak.
- `sandboxAccess.ts`: the one-message fixes for no login, no environment or no Sandbox access.
