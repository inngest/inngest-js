# setup

Getting a project to a valid `ci` config. Detection reads source as text and never imports or runs it.

- `analyze.ts`: pure rules on strings: the `createCi()` instances, the files that serve their functions, route paths of Next.js, SvelteKit and Remix, the package manager, and the start command.
- `detect.ts`: lists the project's files with git, reads them, and applies `analyze.ts` to find the candidate servers, ranked (a `ci/` folder first) and with warnings (no `PORT`, no `tsx`).
- `describe.ts`: what detection found as facts, and the error for a project that can't be set up without a person, which prints the exact `inngest.json` to write.
- `review.ts`: the setup's own prompt, a choice with facts drawn above it.
- `write.ts`: the `inngest.json` merge (other keys and indentation kept) and the `.gitignore` append.
- `guided.ts`: `configure()`: load the config, or detect, confirm and write it, then offer `.gitignore`.
