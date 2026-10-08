# testing

Test-only helpers. Not exported and not built.

- `fakeSandbox.ts`: a fake Sandboxes REST API, with snapshot names and the one file CI keeps on a machine. Clients that share one fake share nothing else, like separate machines against one environment.
- `fakeGitHub.ts`: a fake GitHub HTTP layer.
- `client.ts`: an Inngest client wired to the fake sandbox API.
- `runFunction.ts`: drives a function to completion like the executor.
