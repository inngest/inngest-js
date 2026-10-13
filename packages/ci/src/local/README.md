# local

What the app does only when `inngest-ci` started it (`INNGEST_CI_LOCAL=1`).

- `protocol.ts`: the contract with the CLI: env vars, the run-job event, the manifest and the messages the app sends.
- `jsonSchema.ts`: the JSON Schema subset the CLI's forms read, and deriving it from a Standard Schema without a dependency.
- `reporter.ts`: sends those messages to `INNGEST_CI_REPORTER_URL`, fire-and-forget. It's created once per client, wraps the check sink for pipeline and job transitions, and sends each message once however often a handler replays. `activity()` says what a job is doing at a slow point that isn't a command, like creating a machine. `isLocal()` backs `ci.local`.
- `runJob.ts`: the `ci-run-job` function, served by `ci.functions()` in local runs. It runs one job, or the given combinations of a matrix, by ID through `runPipeline`, like any pipeline.
- `local.test.ts`: tests of the above, with a loopback server standing in for the CLI.
