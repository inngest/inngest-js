# Inngest Google Functions Framework Template

This is a [Google Functions Framework](https://github.com/GoogleCloudPlatform/functions-framework-nodejs) project. It is a reference on how to send and receive events with Inngest and Google's Functions Framework for Node.js. Functions Framework is an Express.js compatible API.

## Getting Started

Use [`create-next-app`](https://www.npmjs.com/package/create-next-app) with [npm](https://docs.npmjs.com/cli/init), [Yarn](https://yarnpkg.com/lang/en/docs/cli/create/), or [pnpm](https://pnpm.io) to bootstrap the example:

```bash
npx create-next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-google-functions-framework inngest-google-functions
```

```bash
yarn create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-google-functions-framework inngest-google-functions
```

```bash
pnpm create next-app --example https://github.com/inngest/inngest-js/tree/main/examples/framework-google-functions-framework inngest-google-functions
```

Enter the directory and run:

```bash
# Transpile TypeScript to JavaScript
npm run build
# Run the service
npm start
```

Open http://localhost:3000 with your browser to see the result.

- [Inngest functions](https://www.inngest.com/docs/functions) are available at `inngest/`.
- The [Inngest handler](https://www.inngest.com/docs/sdk/serve#framework-google-cloud-functions) is available at `index.ts`.

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [Functions Framework Documentation](https://github.com/GoogleCloudPlatform/functions-framework-nodejs) - learn about how to use the Express.js-like Google Functions Framework for Node.js
