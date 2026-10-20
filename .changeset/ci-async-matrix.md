---
"@inngest/ci": minor
---

A matrix's `axes` can now be an async function, so its combinations can come from the commit being tested, such as the examples in the pull request. It runs once per run and is given the repository and commit.

```ts
const examples = ci.matrix(
  {
    id: "examples",
    axes: async ({ repo }) => {
      const entries = await github.rest.repos.getContent({
        path: "examples",
        ref: repo?.sha ?? "",
      });

      const dirs = Array.isArray(entries) ? entries : [];

      return { example: dirs.map((entry) => entry.name) };
    },
  },
  async ({ matrix }) => {
    await $`pnpm test`.env({ EXAMPLE: matrix.example });
  },
);
```
