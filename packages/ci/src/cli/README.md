# cli

The `inngest-ci` command. `main.ts` is the bin (citty); `run.ts` is the whole flow. Prompts, spinner and log lines come from `@clack/prompts`, free ports from `get-port`, process trees from `tree-kill`.

- `main.ts`: arguments and exit code (`0` passed, `1` failed or cancelled, `2` setup error). Unknown `--<axis> <value>` options are matrix axes. No shebang: tsdown adds it.
- `run.ts`: resolve config (guided setup at a terminal), boot, choose a target, send its event, watch the run, cancel strays, stop everything.
- `config.ts`: finds the project root and validates the `ci` key of `inngest.json`, with the `ci/server.*` convention as fallback.
- `setup.ts`: the guided setup prompts that write the `ci` key.
- `devServer.ts`: starts an isolated Dev Server (own ports, `--no-discovery`, no `INNGEST_*` env) and makes the REST calls the CLI needs.
- `app.ts`: starts the app with the CLI's env and waits for the sync and the manifest.
- `processes.ts`: child processes with log files, env scrubbing, stopping a whole tree.
- `reporterServer.ts`: loopback server for the app's `LocalMessage`s (`../local/protocol.ts`).
- `target.ts`: lists targets from the manifest, picks matrix combinations, builds the trigger or run-job event.
- `live.ts`: the spinner and per-job lines shown while a run goes.
- `strays.ts`: cancels runs still going on the way out and waits a bounded time for their cleanup, so Sandboxes don't leak.
- `sandboxAccess.ts`: the one-message fixes for no login, no environment or no Sandbox access.
