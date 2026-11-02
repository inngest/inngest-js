# AI example (TanStack Start)

A TanStack Start app demonstrating `aiMiddleware()`, the bundle that turns on
scoring, metadata, and extended traces together. It builds against the local
`inngest` SDK as a live dependency.

## How it's wired

`src/inngest/client.ts` enables the bundle alongside a middleware of its own, to
show the two compose in the types and at runtime:

```ts
export const inngest = new Inngest({
  id: "example-ai-app",
  middleware: [...aiMiddleware(), HelloWorldMiddleware],
});
```

`src/inngest/functions/helloWorld.ts` then uses everything the bundle adds to the
function context. It hands "Hello, world!" to an `@openai/agents` translator that
delegates constructed languages (Pig Latin, Sindarin) to a second agent, and:

- wraps the agent call in a custom span via `ctx.tracer` (extended traces),
- records the chosen language with `step.metadata()`,
- scores whether the agent answered in the requested language with `step.score()`,
- calls `ctx.greet()`, added by `HelloWorldMiddleware`.

## Prerequisites

- `OPENAI_API_KEY` in the environment — the translator agents call OpenAI
  directly.
- The Inngest Dev Server, to run functions and view the traces, metadata, and
  scores this produces.

The bundle's traces default to the `extendProvider` behaviour, which needs an
OpenTelemetry provider registered before any app code. The `dev` and `start`
scripts do this by loading `@inngest/otel` via `--import`; without it the SDK
warns and spans go nowhere. See
[the OpenTelemetry docs](https://www.inngest.com/docs/examples/open-telemetry).

## Live local SDK

The `inngest` dependency points at the local build output:

```json
"inngest": "file:../../packages/inngest/dist"
```

Other examples in this repo depend on a published version or on a packed
`inngest.tgz`. This one points at `dist` on purpose. npm installs directory
`file:` dependencies as symlinks, so `node_modules/inngest` is a link to
`packages/inngest/dist`, and the SDK's watch build is picked up here with no
repacking or reinstalling:

```sh
cd packages/inngest
pnpm dev  # or `pnpm build` for a one-off build
```

`vite.config.ts` externalizes `inngest` for SSR so it loads straight from
`dist` instead of being bundled (and cached) by Vite. If a change still doesn't
seem to show up, restart the dev server. Vite caches prebundled deps in
`node_modules/.vite`.

## Running

1. Build the SDK (see above) so `packages/inngest/dist` exists.
2. Install and start this app:

   ```sh
   npm install
   OPENAI_API_KEY=sk-... npm run dev
   ```

3. In another terminal, start the Inngest Dev Server pointed at this app:

   ```sh
   npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
   ```

4. Trigger the function by sending a `test/hello.world` event from the Dev
   Server UI at http://localhost:8288. Pass a language to pick one explicitly,
   or omit `data` to have one chosen at random:

   ```json
   { "name": "test/hello.world", "data": { "language": "Sindarin" } }
   ```

The trace shows the custom `translate-to-<language>` span. The metadata shows
the recorded language and the score.
