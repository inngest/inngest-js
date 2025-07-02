# Get started with Next.js & Inngest

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Finngest%2Finngest-js%2Ftree%2Fmain%2Fexamples%2Fframework-nextjs-starter&integration-ids=oac_H9biZULoTuJYFO32xkUydDmT&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22inngest%22%2C%22productSlug%22%3A%22inngest%22%2C%22protocol%22%3A%22workflow%22%2C%22group%22%3A%22%22%7D%5D)

This project is an interactive tour of Inngest useful features for Next.js configured with:

1. **Trigger your first Inngest function** - Learn how to trigger an Inngest function and see its output.

2. **Multi-Step Functions and Streaming** - See how Inngest functions can be divided into fault-tolerant steps and stream updates to the UI.

3. **Fault Tolerance with Retries** - Experience how Inngest handles failures and retries through a function that intentionally fails.

4. **Flow Control: Throttling** - Learn about controlling function execution with features like throttling to handle 3rd party APIs rate limiting.

All functions source code are available in the [`src/lib/demo-functions.ts`](./src/lib/demo-functions.ts).

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Visit [http://localhost:3000](http://localhost:3000)

## Deploy on Vercel

1. Using the following button to create a new Vercel project using this repository:
   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Finngest%2Finngest-js%2Ftree%2Fmain%2Fexamples%2Fframework-nextjs-starter&integration-ids=oac_H9biZULoTuJYFO32xkUydDmT&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22inngest%22%2C%22productSlug%22%3A%22inngest%22%2C%22protocol%22%3A%22workflow%22%2C%22group%22%3A%22%22%7D%5D)

2. Once your Vercel project is deployed, navigate to the [Inngest Vercel Integration](https://vercel.com/integrations/inngest) page and click **Connect Account** (_you can create an Inngest account during this step_).

3. You application is now deployed on Vercel and linked to your Inngest application!

You can find a complete step-by-step [deploy to Vercel guide in our documentation](https://www.inngest.com/docs/deploy/vercel?ref=nextjs-starter-template).
