# Inngest Remix + Vercel Template

This is a [Remix](https://remix.run/) v1 project bootstrapped with [`create-remix`](https://www.npmjs.com/package/create-remix). It is a reference on how to send and receive events with Inngest, Remix, and Vercel.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Finngest%2Fsdk-example-remix-vercel&redirect-url=https%3A%2F%2Fapp.inngest.com%2Fintegrations%2Fvercel&integration-ids=oac_H9biZULoTuJYFO32xkUydDmT)

## Getting Started

Use [`create-next-app`](https://www.npmjs.com/package/create-next-app) with [npm](https://docs.npmjs.com/cli/init), [Yarn](https://yarnpkg.com/lang/en/docs/cli/create/), or [pnpm](https://pnpm.io) to bootstrap the example:

```bash
npx create-next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-remix inngest-remix
```

```bash
yarn create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-remix inngest-remix
```

```bash
pnpm create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-remix inngest-remix
```

Open [http://localhost:3000](http://localhost:3000/api/inngest) with your browser to see the result.

- [Inngest functions](https://www.inngest.com/docs/functions) are available at `app/inngest/`.
- The [Inngest handler](https://www.inngest.com/docs/frameworks/remix) is available a `app/routes/api/inngest.ts`.

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [Remix Documentation](https://remix.run/docs) - learn about Remix features and API.
