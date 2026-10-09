# testing

Test-only helpers. Not exported and not built.

- `fakeSandbox.ts`: a fake Sandboxes REST API, with snapshot names, the one file CI keeps on a machine and the files uploaded to it. Clients that share one fake share nothing else, like separate machines against one environment.
- `fakeGitHub.ts`: a fake GitHub HTTP layer.
- `client.ts`: an Inngest client wired to the fake sandbox API, which also records the functions it creates.
- `events.ts`: the pull request event and trigger tests share.
- `runFunction.ts`: drives a function to completion like the executor, including `step.invoke` of the functions the test client created. Invokes run beside the function, and the function is called again as each one ends; runs of one `event.data` concurrency key take turns.
- `schema.ts`: a fake Standard Schema that can also write itself as JSON Schema.
