# inngest

[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/inngest)](https://www.npmjs.com/package/inngest)
[![Discord](https://img.shields.io/discord/842170679536517141?label=discord)](https://discord.gg/EuesV2ZSnX)
[![Twitter Follow](https://img.shields.io/twitter/follow/inngest?style=social)](https://twitter.com/inngest)

Build, test, and deploy code that runs in response to events or on a schedule right in your own codebase.

👋 _**Have a question or feature request? [Join our Discord](https://www.inngest.com/discord)!**_

```
npm install inngest
```

```ts
// Send events
import { Inngest } from "inngest";
const inngest = new Inngest({ name: "My App" });

inngest.send("app/user.created", { data: { id: 123 } });
```

```ts
// Listen to events
import { createFunction } from "inngest";

export default createFunction(
  "Send welcome email",
  "app/user.created",
  ({ event }) => {
    sendEmailTo(event.data.id, "Welcome!");
  }
);
```

## Getting started

Links to how to start, platforms, frameworks, logos?

## Contributing

Clone the repository, then:

```sh
yarn # install dependencies
yarn dev # build/lint/test
```

We use [Volta](https://volta.sh/) to manage Node/Yarn versions.

When making a pull request, make sure to commit the changed `etc/inngest.api.md` file; this is a generated types/docs file that will highlight changes to the exposed API.
