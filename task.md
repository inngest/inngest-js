## Implementation

New stuff in `packages/inngest/src/components/InngestMiddlewareV2.ts`.

Do not worry about completely breaking the `InngestMiddleware` class. We'll eventually replace it with the new stuff.

Do not worry about breaking changes.

The only execution file to modify is `v1.ts`. We're removing `v0.ts` soon, and we'll worry about `v2.ts` later.

## Tests

To quickly verify your changes, run the following commands in the repo root:

```sh
pnpm -C packages/inngest test:integration
```

Do not worry about running a comprehensive test suite yet.

New tests are in:
```
packages/inngest/src/components/InngestMiddlewareV2.test.ts
packages/inngest/src/test/integration/middleware/
```
