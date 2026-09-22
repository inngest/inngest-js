<div align="center">
  <br/>
    <a href="https://www.inngest.com"><img src="https://github.com/inngest/.github/raw/main/profile/github-readme-banner-2025-06-20.png"/></a>
  <br/>
  <br/>
  <p>
    Inngest is the reliability layer for modern applications. It combines durable execution, events, and queues into a zero-infra platform with built-in observability.
  </p>

**Works with:**
<br/>
<img src="https://jsr.io/logos/browsers.svg" height="20" />
<img src="https://jsr.io/logos/bun.svg" height="20" />
<img src="https://jsr.io/logos/deno.svg" height="20" />
<img src="https://jsr.io/logos/node.svg" height="20" />
<img src="https://jsr.io/logos/cloudflare-workers.svg" height="20" />

Read the <a href="https://www.inngest.com/docs?ref=github-inngest-js-readme">documentation</a> and get started in minutes.
<br/>

  <p>

<a href="https://www.npmjs.com/package/inngest"><img src="https://img.shields.io/npm/v/inngest" /></a>
<br/>
<a href="https://www.inngest.com/discord"><img src="https://img.shields.io/discord/842170679536517141?label=discord" /></a>
<a href="https://twitter.com/inngest"><img src="https://img.shields.io/twitter/follow/inngest?style=social" /></a>

  </p>
</div>

<hr />

On _any_ serverless platform ([Next.js](https://www.inngest.com/docs/sdk/serve#framework-next-js), [Deno Deploy](https://www.inngest.com/docs/sdk/serve#framework-fresh-deno), [RedwoodJS](https://www.inngest.com/docs/sdk/serve#framework-redwood), [AWS Lambda](https://www.inngest.com/docs/sdk/serve#framework-aws-lambda), and [anything else](https://www.inngest.com/docs/sdk/serve#custom-frameworks)) and with no extra infrastructure:

- ⚡ Write <b>background jobs</b>
- 🕐 Create <b>scheduled and cron jobs</b>
- ♻️ Build <b>serverless queues</b>
- 🪜 Write complex <b>step functions</b>
- 🚘 Build <b>serverless event-driven systems</b>
- 🪝 Reliably respond to webhooks, with retries and payloads stored for history

👋 _Have a question or feature request? [Join our Discord](https://www.inngest.com/discord)!_

<br />

<p align="center">
<a href="#getting-started">Getting started</a> ·
<a href="#features">Features</a> ·
<a href="#version-support">Version support</a> ·
<a href="#contributing">Contributing</a> ·
<a href="https://www.inngest.com/docs?ref=github-inngest-js-readme">Documentation</a>
</p>

<br />

## Getting started

<br />

Install Inngest:

```bash
npm install inngest
```

### Writing functions

Write serverless functions and background jobs right in your own code:

```ts
import { Inngest } from "inngest";

const inngest = new Inngest({ id: "my-app" });

// This function will be invoked by Inngest via HTTP any time
// the "app/user.signup" event is sent to to Inngest
export default inngest.createFunction(
  {
    id: "user-onboarding-communication",
    triggers: [{ event: "app/user.signup" }],
  },
  async ({ event, step }) => {
    await step.run("Send welcome email", async () => {
      await sendEmail({
        email: event.data.email,
        template: "welcome",
      });
    });
  }
);
```

- Functions are triggered by events which can be sent via this SDK, webhooks, integrations, or with a simple HTTP request.
- When a matching event is received, Inngest invokes the function automatically, with built-in retries.

### Serving your functions

Inngest invokes functions via HTTP, so you need to _serve_ them using an adapter for the framework of your choice. [See all frameworks here in our docs](https://www.inngest.com/docs/sdk/serve?ref=github-inngest-js-readme). Here is an example using the Next.js serve handler:

```ts
// /pages/api/inngest.ts
import { Inngest } from "inngest";
// See the "inngest/next" adapter imported here:
import { serve } from "inngest/next";
import myFunction from "../userOnboardingCommunication"; // see above function

// You can create this in a single file and import where it's needed
const inngest = new Inngest({ id: "my-app" });

// Securely serve your Inngest functions for remote invocation:
export default serve(inngest, [myFunction]);
```

### Sending events to trigger functions

```ts
// Send events
import { Inngest } from "inngest";
const inngest = new Inngest({ id: "my-app" });

// This will run the function above automatically, in the background
inngest.send("app/user.signup", {
  data: { email: "text@example.com", user_id: "12345" },
});
```

- Events can trigger one or more functions automatically, enabling you to fan-out work.
- Inngest stores a history of all events for observability, testing, and replay.

<br />

## Effect v4

`inngest/effect` is an opt-in, **ESM-only** integration with
`effect@4.0.0-rc.117`. Install that exact version while Effect v4 is a release
candidate. Effect is an optional peer: applications using only the normal SDK
do not need to install it. Existing CommonJS entrypoints are unchanged;
`require("inngest/effect")` is intentionally not exported.

```sh
npm install inngest effect@4.0.0-rc.117
```

Keep your existing client, function options, triggers, and serve adapter. Add
`EffectMiddleware` at client or function level and return `effect.run(...)`:

```ts
import { Effect } from "effect";
import { Inngest } from "inngest";
import { EffectMiddleware } from "inngest/effect";

const inngest = new Inngest({
  id: "orders",
  middleware: [EffectMiddleware],
});

export const calculateOrder = inngest.createFunction(
  { id: "calculate-order", triggers: { event: "order/received" } },
  ({ event, step, effect }) =>
    effect.run(
      Effect.gen(function* () {
        const total = yield* effect.step(
          (subtotal: number) => Effect.succeed({ total: subtotal * 1.2 }),
          (run) => step.run("calculate-total", run, event.data.subtotal),
        );

        yield* effect.promise(() => step.sleep("settlement-delay", "1h"));
        return total;
      }),
    ),
);
```

### Effect and durable-step boundaries

- **`effect.run(program, { signal? })`** is the handler boundary. Provide all
  required services with `Effect.provide` / `Effect.provideService`, and close
  scopes with `Effect.scoped`. Missing services are a TypeScript error.
- **`effect.step(body, register)`** captures the current Effect services and
  supplies a Promise callback to your native `step.run` or `step.ai.wrap`.
  The body runs only when Inngest executes that step, not during discovery or
  memoized replay. Keeping the native call explicit preserves edited inputs,
  middleware output transformations, and output type inference.
- **`effect.promise(thunk)`** lazily lifts any native Promise-returning tool,
  including `step.sleep`, `step.waitForEvent`, `step.invoke`, `step.sendEvent`,
  and middleware extensions. Pass a thunk, not an already-started Promise.
  For cancellable external APIs, declare and forward its `AbortSignal`, e.g.
  `effect.promise((signal) => fetch(url, { signal }))`.
- Parallel durable branches work with
  `Effect.all(branches, { concurrency: "unbounded" })`; Effect's default
  concurrency is sequential. Use stable, distinct step IDs.

Inngest persists step results, **not Effect fibers or services**. Ordinary
Effect work outside durable steps is replayed on each invocation.
`Effect.sleep`, `Effect.retry`, and in-process waits inside a step do not
become durable operations. Use native `step.sleep` / `step.waitForEvent` for
durable waiting. In-process retries multiply the attempts inside each
Inngest retry; choose that policy explicitly.

Typed errors can be recovered inside a step with normal Effect operators.
At the durable boundary, errors have type `unknown`: a replayed `StepError`
cannot honestly retain the original error class or Effect error type.
Uncaught failures and defects preserve the original error at the Promise
boundary, including `NonRetriableError` and `RetryAfterError`.
Return JSON-compatible results; use schemas/codecs when domain values need
reconstruction after replay.

### Resource ownership and cancellation

Scopes belong to **one SDK invocation**, not an entire durable run. On
suspension, the middleware interrupts its active fibers and waits for their
finalizers before ending the invocation. Streaming responses are special:
cleanup runs when the execution loop ends, not when the early SSE response
is returned. Interrupted step cleanup finishes before parent services close.
Execution-end hooks unwind middleware in reverse registration order, keeping
outer middleware resources alive for inner finalizers.
Normal suspension is not reported as a function failure; cleanup defects are
reported through the SDK's middleware error logger.

Acquire resources inside a step when they are needed only for that step.
Finalizers must terminate and must not schedule durable steps. Uninterruptible
work can delay shutdown; JavaScript cannot preempt synchronous blocking code.
Detached fibers (`Effect.forkDetach`), manually started runtimes, and external
Promises that ignore cancellation remain application-owned. Aborting a local
Effect does not cancel already-registered durable operations or cancel the
server-side Inngest run.

### Platforms and verification

The integration uses Effect's platform-neutral core; it adds no Node-specific
runtime or `AsyncLocalStorage` requirement. Continue using the appropriate
Inngest serve adapter and platform-compatible services. Node/Bun filesystem
Layers are not portable to Workers merely because the handler is an Effect.
Cloudflare verification uses `nodejs_compat`, as required by the tested SDK
configuration.

Built-package protocol smoke scenarios live in `test/effect-platform/`, with
a Node/Bun/Deno/local-workerd CI matrix in `.github/workflows/effect.yml`.
They exercise discovery, selected-step execution, replay, serialization,
durable sleep opcodes, retry-control responses, and asynchronous cleanup.
The separate `src/test/integration/effect.test.ts` uses the real Inngest Dev
Server to verify actual retries, parallel steps, elapsed durable sleep, and
memoized side effects:

```sh
# From packages/inngest after installing workspace dependencies:
pnpm build
pnpm test src/effect.test.ts src/components/execution/lifecycle.test.ts
pnpm test:integration src/test/integration/effect.test.ts
node test/effect-platform/run.mjs
bun test/effect-platform/run.mjs
deno run --no-lock --node-modules-dir=manual --allow-env --allow-read --allow-sys test/effect-platform/run.mjs
node test/effect-platform/workers.mjs
```

The Workers smoke runs locally; it does not deploy anything. These checks are
regression evidence, not a claim of production soak testing or compatibility
with untested future Effect release candidates.

## Features

- **Fully serverless:** Run background jobs, scheduled functions, and build event-driven systems without any servers, state, or setup
- **Works with your framework**: Works with [Next.js, Redwood, Express, Cloudflare Pages, Nuxt, Fresh (Deno), and Remix](https://www.inngest.com/docs/sdk/serve?ref=github-inngest-js-readme)
- **Deploy anywhere**: Keep [deploying to your existing platform](https://www.inngest.com/docs/deploy?ref=github-inngest-js-readme): Vercel, Netlify, Cloudflare, Deno, Digital Ocean, etc.
- **Use your existing code:** Write functions within your current project and repo
- **Fully typed**: Event schemas, versioning, and governance out of the box
- **Observable**: A full UI for managing and inspecting your functions

<br />

## Version support

The library works across browsers, Bun, Deno, Node, and Cloudflare Workers.

We support the LTS versions of these runtimes and the last 3 minor versions of
TypeScript; once a runtime version drops out of LTS, any major, minor, or patch
update to the `inngest` library may drop support for it, which will be mentioned
in the patch notes.

## Contributing

Check out [`CONTRIBUTING.md`](CONTRIBUTING.md) to get started.
