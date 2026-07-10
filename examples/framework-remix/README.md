# Inngest React Router 7 + Vercel Template

This is a [React Router 7](https://reactrouter.com/) (framework mode, the successor to Remix v2) project. It is a reference on how to send and receive events with Inngest, React Router, and Vercel.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Finngest%2Finngest-js%2Ftree%2Fmain%2Fexamples%2Fframework-remix&redirect-url=https%3A%2F%2Fapp.inngest.com%2Fintegrations%2Fvercel&integration-ids=oac_H9biZULoTuJYFO32xkUydDmT)

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result. The Inngest handler is mounted at `/api/inngest`.

- [Inngest functions](https://www.inngest.com/docs/functions) are defined in `app/inngest/`.
- The [Inngest handler](https://www.inngest.com/docs/learn/serving-inngest-functions) is at `app/routes/api/inngest.ts` and uses the `inngest/remix` adapter, which works with React Router 7's loader/action signature.

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [React Router Documentation](https://reactrouter.com) - learn about React Router framework features and APIs
