<div align="center">
  <br/>
    <a href="https://www.inngest.com"><img src="https://user-images.githubusercontent.com/306177/191580717-1f563f4c-31e3-4aa0-848c-5ddc97808a9a.png" width="250" /></a>
  <br/>
  <br/>
  <p>
    Serverless event-driven queues, background jobs, and scheduled jobs for Typescript.<br />
    Works with any framework and platform.
  </p>
  Read the <a href="https://www.inngest.com/docs?ref=github-inngest-js-readme">documentation</a> and get started in minutes.
  <br/>
  <p>

<a href="http://www.typescriptlang.org/"><img src="https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg" /></a>
<a href="https://www.npmjs.com/package/inngest"><img src="https://img.shields.io/npm/v/inngest" /></a>
<a href="https://discord.gg/EuesV2ZSnX"><img src="https://img.shields.io/discord/842170679536517141?label=discord" /></a>
<a href="https://twitter.com/inngest"><img src="https://img.shields.io/twitter/follow/inngest?style=social" /></a>

  </p>
</div>

<hr />

Inngest allows you to:

- 👉 Write <b>background jobs</b> in any framework, on any platform <br />
- 👉 Create <b>scheduled & cron jobs</b> for any serverless platform <br />
- 👉 Build <b>serverless queues</b> without configuring infra <br />
- 👉 Write complex <b>step functions</b> anywhere <br />
- 👉 Build <b>serverless event-driven systems</b> <br />
- 👉 Reliably respond to webhooks, with retries & payloads stored for history <br />

👋 _Have a question or feature request? [Join our Discord](https://www.inngest.com/discord)!_

<br />

<p align="center">
<a href="#getting-started">Getting started</a> ·
<a href="#features">Features</a> ·
<a href="#contributing">Contributing</a> ·
<a href="https://www.inngest.com/docs?ref=github-inngest-js-readme">Documentation</a>
</p>

<br />

## Getting started

<br />

Install Inngest:

```bash
npm install inngest  # or yarn add inngest
```

### Writing functions

Write serverless functions and background jobs right in your own code:

```ts
import { Inngest } from "inngest";

const inngest = new Inngest({ name: "My App" });

// This function will be invoked by Inngest via HTTP any time
// the "app/user.signup" event is sent to to Inngest
export default inngest.createFunction(
  { name: "User onboarding communication" },
  { event: "app/user.signup" },
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
import myFunction from "../userOnboardingCOmmunication"; // see above function

// You can create this in a single file and import where it's needed
const inngest = new Inngest({ name: "My App" });

// Securely serve your Inngest functions for remote invocation:
export default serve(inngest, [myFunction]);
```

### Sending events to trigger functions

```ts
// Send events
import { Inngest } from "inngest";
const inngest = new Inngest({ name: "My App" });

// This will run the function above automatically, in the background
inngest.send("app/user.signup", {
  data: { email: "text@example.com", user_id: "12345" },
});
```

- Events can trigger one or more functions automatically, enabling you to fan-out work.
- Inngest stores a history of all events for observability, testing, and replay.

<br />

## Features

- **Fully serverless:** Run background jobs, scheduled functions, and build event-driven systems without any servers, state, or setup
- **Works with your framework**: Works with [Next.js, Redwood, Express, Cloudflare Pages, Nuxt, Fresh (Deno), and Remix](https://www.inngest.com/docs/sdk/serve?ref=github-inngest-js-readme)
- **Deploy anywhere**: Keep [deploying to your existing platform](https://www.inngest.com/docs/deploy?ref=github-inngest-js-readme): Vercel, Netlify, Cloudflare, Deno, Digital Ocean, etc.
- **Use your existing code:** Write functions within your current project and repo
- **Fully typed**: Event schemas, versioning, and governance out of the box
- **Observable**: A full UI for managing and inspecting your functions

<br />

## Contributing

Clone the repository, then:

```sh
yarn # install dependencies
yarn dev # build/lint/test
```

We use [Volta](https://volta.sh/) to manage Node/Yarn versions.

> When making a pull request, make sure to commit the changed `etc/inngest.api.md` file; this is a generated types/docs file that will highlight changes to the exposed API.

### Locally linking (`npm|yarn link`)

In order to provide sensible namespaced imports such as `"inngest/next"`, the package actually builds to _and deploys from_ `dist/`.

To replicate this locally to test changes with other local repos, you can link the project like so (replace `npm` for `yarn` if desired):

```sh
# in this repo
yarn build
yarn prelink
cd dist/
yarn link
```

```sh
# in another repo
yarn link inngest
```
