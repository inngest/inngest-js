---
"@inngest/ci": minor
---

You can now run pipelines locally with `inngest-ci`. It runs your pipeline or job against your working tree, uncommitted changes included, and shows every job live.

```sh
npx inngest-ci pr
npx inngest-ci build --input '{"target":"web"}'
```

Use `ci.local` in a pipeline to leave out what only makes sense in CI.
