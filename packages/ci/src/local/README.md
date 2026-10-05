# local

What the app does only when `inngest-ci` started it (`INNGEST_CI_LOCAL=1`).

- `protocol.ts`: the contract with the CLI: env vars, the run-job event, the manifest and the messages the app sends.
- `reporter.ts`: sends those messages to `INNGEST_CI_REPORTER_URL`, fire-and-forget. It's created once per client, wraps the check sink for pipeline and job transitions, and sends each message once however often a handler replays. `isLocal()` backs `ci.local`.
- `runJob.ts`: the `ci-run-job` function, served by `ci.functions()` in local runs. It runs one job or matrix by ID through `runPipeline`, like any pipeline.
- `local.test.ts`: tests of the above, with a loopback server standing in for the CLI.
