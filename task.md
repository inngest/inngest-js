# Task: `@inngest/middleware-superjson`

New middleware package at `packages/middleware-superjson/` that uses [superjson](https://www.npmjs.com/package/superjson) to preserve non-JSON types (Date, RegExp, BigInt, Map, Set, URL, Error, undefined, etc.) through Inngest's data pipeline.

Branch: `superjson-serializer` (1 commit ahead of `main`)

## What exists

- `src/base-serializer.ts` — `BaseSerializerMiddleware` copied from `packages/inngest/src/test/integration/utils.ts`. Hooks into the middleware pipeline (transformFunctionInput, wrapFunctionHandler, transformStepInput, wrapStepHandler, wrapStep, transformSendEvent).
- `src/middleware.ts` — `SuperJsonMiddleware` extends BaseSerializerMiddleware with `recursive = false`. Wraps entire values in a `{ __inngestSuperJson, json, meta }` envelope using superjson's serialize/deserialize. Includes `Preserved<T>` type transform, factory function, subclass pattern for custom SuperJSON instances.
- `src/index.ts` — Re-exports.
- `src/middleware.test.ts` — 21 tests. All runtime tests go through `JSON.parse(JSON.stringify())` to verify wire-transport fidelity.

## Key design decisions

- **Whole-object serialization** — superjson handles tree walking internally, so BaseSerializerMiddleware's recursive mode is off. Each value (event data, step output, function output) is serialized as a single envelope.
- **`Preserved<T>`** — Identity type minus functions/symbols. Declared on `functionOutputTransform` / `stepOutputTransform` so TypeScript reflects runtime types.
- **Custom types** — Users pass a configured `SuperJSON` instance via factory (`superJsonMiddleware({ instance })`) or subclass (`protected override sj = ...`).

## Commands

```sh
cd packages/middleware-superjson
pnpm test                              # 21 tests
pnpm exec tsc --noEmit --project tsconfig.build.json  # type-check
```
