# cli

The `inngest-ci` command: runs one pipeline or job of the user's app locally. `main.ts` is the bin; everything else is a step of `session.ts`.

- `main.ts`: parses argv, picks a renderer, runs a session, exits `0` passed, `1` failed or cancelled, `2` setup error. No shebang: tsdown adds it.
- `args.ts`: `parseCliArgs()`. Unknown `--<axis> <value>` options are matrix axes, split out before `parseArgs`.
- `config.ts`: finds the project root (nearest `inngest.json`, never above the git root) and validates its `ci` key, with the `ci/server.*` convention as fallback.
- `devServer.ts`: binary resolution (env, config, project `inngest-cli`, then `PATH`), the version check, the isolating flags, and start and readiness.
- `devServerApi.ts`: the Dev Server REST calls (`/health`, `/dev`, `/e/local`, `/v2/runs`). REST only, never GraphQL.
- `app.ts`: starts the app with the CLI's env and waits for the sync and the manifest.
- `process.ts`: spawns a process group with a log file, stops it (`SIGTERM`, then `SIGKILL`), scrubs `INNGEST_*` from env, reads log tails.
- `ports.ts`: `freePorts()`.
- `reporterServer.ts`: loopback server that receives the app's `LocalMessage`s (see `../local/protocol.ts`).
- `target.ts`: matches the target against the manifest and builds the trigger or run-job event from `fixtures`.
- `session.ts`: the flow. Emits `SessionEvent`s (`events.ts`) and never throws; the last event is always `done`.
- `stateDir.ts`: where session state files live (`INNGEST_CI_STATE_DIR`, XDG, platform default) and pruning of old ones.
- `render/`: the interactive and plain views of those events, and `stateFile.ts`, which publishes the session's live state as JSON for editor integrations.

A failure the user must fix throws `SetupError` (`setupError.ts`) with an optional `fix` and `logTail`; the session turns it into a `setup-error` event.
