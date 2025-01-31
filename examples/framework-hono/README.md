# Inngest Hono Template

This is a [Hono](https://hono.dev/) v4 project targetting Cloudflare Workers. It is a reference on how to send and receive events with Inngest and Hono.

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

```sh
npm install
npm run dev
```

Open http://localhost:8787/api/inngest (or the URL that Wrangler returns) with your browser to see the result.

- [Inngest functions](https://www.inngest.com/docs/functions) are available at `src/inngest/`.
<!-- - The [Inngest handler](https://www.inngest.com/docs/sdk/serve#framework-hono) is available at `index.ts`. -->

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [Hono Documentation](https://hono.dev/top) - learn about Hono features and API
