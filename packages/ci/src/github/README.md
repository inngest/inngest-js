# github

Everything GitHub.

- `auth.ts`: token and console providers.
- `triggers.ts`: `github.pullRequest()`, `github.push()`, comment triggers and their permission rules.
- `events.ts`: turning webhooks into Inngest events and reading repository context from them.
- `fixtures.ts`: local event fixtures standing in for webhooks when running from a working tree.
- `checks.ts`: check run, commit status and console reporting.
- `rest.ts`: the durable REST client.
- `source.ts`: resolving the repository and ref `checkout()` and `files()` read to a commit, and finding the installation that can read it.
- `deployRepo.ts`: which repository and commit the app was deployed from, read from host variables or the working directory's git checkout, for builds another app asks for.
- `helpers.ts`: the `github.*` helpers, gathered in `index.ts`.
