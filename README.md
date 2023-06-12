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

<a href="http://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TS-%3E%3D4.7-blue" /></a>
<a href="https://www.npmjs.com/package/inngest"><img src="https://img.shields.io/npm/v/inngest" /></a>
<br/>
<a href="https://discord.gg/EuesV2ZSnX"><img src="https://img.shields.io/discord/842170679536517141?label=discord" /></a>
<a href="https://twitter.com/inngest"><img src="https://img.shields.io/twitter/follow/inngest?style=social" /></a>

  </p>
</div>

<hr />

On _any_ serverless platform ([Next.js](https://www.inngest.com/docs/sdk/serve#framework-next-js), [Deno Deploy](https://www.inngest.com/docs/sdk/serve#framework-fresh-deno), [RedwoodJS](https://www.inngest.com/docs/sdk/serve#framework-redwood), [AWS Lambda](https://www.inngest.com/docs/sdk/serve#framework-aws-lambda), and [anything else](https://www.inngest.com/docs/sdk/serve#custom-frameworks)) and with no extra infrastructure:

- ⚡ Write <b>background jobs</b>
- 🕐 Create <b>scheduled & cron jobs</b>
- ♻️ Build <b>serverless queues</b>
- 🪜 Write complex <b>step functions</b>
- 🚘 Build <b>serverless event-driven systems</b>
- 🪝 Reliably respond to webhooks, with retries & payloads stored for history

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
yarn dev # install dependencies, build/lint/test
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

# in another repo
yarn link inngest
```

Alternatively, you can also package the library and ship it with an application. This is a nice way to generate and ship snapshot/test versions of the library to test in production environments without requiring releasing to npm.

```sh
# in this repo
yarn local:pack
cp inngest.tgz ../some-other-repo-root

# in another repo
yarn add ./inngest.tgz
```

Some platforms require manually installing the package again at build time to properly link dependencies, so you may have to change your `yarn build` script to be prefixed with this install, e.g.:

```sh
yarn add ./inngest.tgz && framework dev
```

### Releasing

To release to production, we use [Changesets](https://github.com/changesets/changesets). This means that releasing and changelog generation is all managed through PRs, where a bot will guide you through the process of announcing changes in PRs and releasing them once merged to `main`.

#### Legacy versions

Merging and releasing to previous major versions of the SDK is also supported.

- Add a `backport v*.x` label (e.g. `backport v1.x`) to a PR to have a backport PR generated when the initial PR is merged.
- Merging into a `v*.x` branch creates a release PR (named **Release v1.x**, for example) the same as the `main` branch. Simply merge to release.

#### Snapshot versions

If a local `inngest.tgz` isn't ideal, we can release a tagged version to npm. For now, this is relatively manual. For this, please ensure you are in an open PR branch for observability.

Decide on the "tag" you will be publishing to, which will dictate how the user installs the snapshot, e.g. if your tag is `beta`, the user will install using `inngest@beta`.

You can see the currently available tags on the [`inngest` npm page](https://www.npmjs.com/package/inngest?activeTab=versions).

> **NEVER** use the `latest` tag, and **NEVER** run `npm publish` without specifying `--tag`.

If the current active version is `v1.1.1`, this is a minor release, and our tag is `foo`, we'd do:

```sh
yarn version v1.2.0-foo.1
yarn build
yarn prelink
cd dist/
npm publish --access public --tag foo
```

You can iterate the final number for each extra snapshot you need to do on a branch.
