# Inngest Hono Template

This is a [Hono](https://hono.dev/) v4 project targetting Cloudflare Workers +
Vite. It is a reference on how to send and receive events with Inngest and Hono.

## Getting Started

Use [`create-next-app`](https://www.npmjs.com/package/create-next-app) with [npm](https://docs.npmjs.com/cli/init), [Yarn](https://yarnpkg.com/lang/en/docs/cli/create/), or [pnpm](https://pnpm.io) to bootstrap the example:

```bash
npx create-next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-hono inngest-hono
```

```bash
yarn create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-hono inngest-hono
```

```bash
pnpm create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-hono inngest-hono
```

### Run the app locally

```txt
npm install
npm run dev
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```
