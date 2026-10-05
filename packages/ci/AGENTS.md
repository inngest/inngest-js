# Agent Guidance

`@inngest/ci` runs CI pipelines as Inngest functions, with each job on an Inngest Sandbox.

## Package contract

- `@inngest/ci` is the only entrypoint. Export public API from `src/index.ts` only.
- Import the SDK only through its public entrypoints: `inngest`, `inngest/experimental` and `inngest/types`. Never deep-import SDK internals; `inngest` is a peer dependency.
- Keep the user-facing API independent of the Sandboxes API. Sandbox quirks are handled here, not exposed.
- Don't export APIs that throw because the platform can't do them yet. List them in the README's "Things we want to do".

## Code style

- Every file opens with a short block comment saying what the file is for and what belongs in it, tagged `@module`.
- No `@param` tags. Document a parameter or option with a `/** … */` comment directly on it.
- Put an empty line between statements. The only exception is a run of related statements that each fit on one line, such as a few variables set up for the code below; those may sit together. A statement that spans several lines always gets an empty line before it (unless it opens the block) and after it. Biome has no rule for this, but its formatter keeps single blank lines, so apply it by hand.

  ```ts
  const { owner, repo } = github.repo();
  const sha = event.data.after;

  await runMe();

  return true;
  ```

- Arrow functions use `{}` and an explicit `return` by default. An expression body is fine only for a trivial one-liner that never wraps and is unlikely to grow, such as `.map((job) => job.id)`. Expect it rarely.

## Docs

- `README.md` is user-facing. Follow the style of https://www.inngest.com/docs: terse, direct, code first.
- Every folder under `src/` has a short contributor `README.md` saying what lives there. Keep it current when moving files.

## Validation

```sh
pnpm -C packages/inngest run build   # ci's devDependency links to the SDK's dist
pnpm -C packages/ci run type-check
pnpm -C packages/ci run lint
pnpm -C packages/ci run format:check
pnpm -C packages/ci run test
pnpm -C packages/ci run build
```
