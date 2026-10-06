# cli

The `inngest-ci` command: runs pipelines and jobs of the user's app locally, or opens an earlier run. `main.ts` is the bin; everything else is a step of `session.ts` or of `openRun.ts`.

- `main.ts`: parses argv, picks a renderer, runs a session (or `open`), exits `0` passed, `1` failed or cancelled, `2` setup error. No shebang: tsdown adds it.
- `args.ts`: `parseCliArgs()`, including the `open` command and `--fixture`. Unknown `--<axis> <value>` options are matrix axes, split out before `parseArgs`.
- `config.ts`: finds the project root (nearest `inngest.json`, never above the git root) and validates its `ci` key, with the `ci/server.*` convention as fallback. Nothing to start the app with is a `NoConfigError`, which setup answers.
- `setup/`: detecting how the project serves `ci.functions()` and writing the config, with a person's confirmation in a terminal.
- `devServer.ts`: binary resolution (env, config, project `inngest-cli`, then `PATH`), the version check, the isolating flags, and start and readiness. Each session has its own persisted database, because two Dev Servers can't share one.
- `devServerApi.ts`: the Dev Server REST calls (`/health`, `/dev`, `/e/local`, `/v2/runs`, and the Sandbox access check on `/dev/cloud/status` and `/v2/sandboxes`). REST only, never GraphQL.
- `app.ts`: starts the app with the CLI's env and waits for the sync and the manifest. Its `PATH` starts with the project's `node_modules/.bin` directories, nearest first.
- `process.ts`: spawns a process group with a log file, stops it (`SIGTERM`, then `SIGKILL`), scrubs `INNGEST_*` from env, reads log tails.
- `sandboxAccess.ts`: the setup errors for a Dev Server that is not logged in, a login without one environment, or an account without Sandbox access.
- `ports.ts`: `freePorts()`.
- `reporterServer.ts`: loopback server that receives the app's `LocalMessage`s (see `../local/protocol.ts`).
- `target.ts`: lists and matches targets in the manifest, picks matrix combinations from axis flags, and builds the trigger or run-job event from `fixtures`.
- `input.ts`: the data a run needs beyond its target. Flags beat a saved fixture, which beats a form built from the data's schema. Flags and fixtures are checked against the schema too.
- `fixtureStore.ts`: saved inputs, `<dir>/fixtures/<target>/<name>.json`.
- `prompter.ts`: the questions the session asks at a terminal (`Prompter`), which the interactive renderer answers.
- `prompt/`: the picker and the prompts, as pure state plus the lines that draw them.
- `runs.ts`: matching messages to the several runs a session sends, and combining their conclusions.
- `openRun.ts`: `inngest-ci open`, a Dev Server alone on the database of the session that ran the run.
- `session.ts`: the flow: resolve the config (setup included), boot, choose, send every event, watch every run, and offer to go again. When the config turns out wrong, it offers to run setup again and starts over with a `restart` event. Emits `SessionEvent`s (`events.ts`) and never throws; every session ends with a `done` event.
- `stateDir.ts`: where session state files live (`INNGEST_CI_STATE_DIR`, XDG, platform default), pruning of old ones together with their Dev Server databases, and finding the session that ran a run.
- `render/`: the interactive and plain views of those events, and `stateFile.ts`, which publishes the session's live state as JSON for editor integrations.

A failure the user must fix throws `SetupError` (`setupError.ts`) with an optional `fix` and `logTail`; the session turns it into a `setup-error` event.
