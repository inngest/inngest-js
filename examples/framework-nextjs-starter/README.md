# Get started with Next.js & Inngest

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
2. Run the Next.js development server:
   ```bash
   npm run dev
   ```
3. Run the Inngest dev server:
   ```bash
   npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
   ```
4. Visit [http://localhost:3000](http://localhost:3000)

## Deploy on Vercel

You can deploy this project to Vercel with a few clicks:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=Develop%20AI%20products%20at%20the%20speed%20of%20thought%20with%20Inngest%20and%20Next.js.%20Demo%20features%20like%20background%20jobs%2C%20real-time%20updates%2C%20and%20throttling.&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F7gjXqVzphYzQuTsU2GqS0W%2F5aced5f656ca71e21421e14d1d6e27ca%2Fvercel-template-thumbnail.png&demo-title=Inngest%20on%20Next.js%20Starter&demo-url=https%3A%2F%2Finngest-nextjs-starter.vercel.app&from=templates&products=%255B%257B%2522type%2522%253A%2522integration%2522%252C%2522protocol%2522%253A%2522workflow%2522%252C%2522productSlug%2522%253A%2522account%2522%252C%2522integrationSlug%2522%253A%2522inngest%2522%257D%255D&project-name=Inngest%20on%20Next.js%20Starter&repository-name=inngest-starter&repository-url=https%3A%2F%2Fgithub.com%2Finngest%2Finngest-js%2Ftree%2Fmain%2Fexamples%2Fframework-nextjs-starter&skippable-integrations=1)

You can also find a complete step-by-step [deploy to Vercel guide in our documentation](https://www.inngest.com/docs/deploy/vercel?ref=nextjs-starter-template).
