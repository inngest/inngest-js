# Inngest Nest.js Template

This is a [Nest.js](https://nestjs.com/) project bootstrapped with [`@nestjs/cli`](https://github.com/nestjs/nest-cli). It is a reference on how to inject nest.js dependencies/providers in inngest function and receive events with Inngest, Nest.js

## Getting Started

## How to use

- Clone the repository
- Setup INNGEST_EVENT_KEY,INNGEST_SIGNING_KEY env variables in dev script of package.json file in (examples/framework-nestjs). For example "dev": "INNGEST_EVENT_KEY='' INNGEST_SIGNING_KEY='' nest start --watch". In production environment you can use docker to pass environment variables. We are not setting up env variables through .env file because the file is loaded by after the inngest client is setup , so it throws the error of missing EVENT_KEY.
- Run the following command in the `packages/inngest/` directory to install packages:

```sh
pnpm install
```

- Run the example using following command :

```sh
pnpm dev:example
```

- Select 'framework-nestjs' from the examples to run

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

- [Inngest functions](https://www.inngest.com/docs/functions) are available at `src/modules/common/inngest/functions`.
- The [Inngest handler](https://www.inngest.com/docs/frameworks/nextjs) is available a `src/main.ts`.

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [Nest.js Documentation](https://docs.nestjs.com/) - learn about Nest.js features and API.

```

```
