# inngest-node

```
npm install inngest
```

👋 _**Have a question or feature request? [Join our Discord](https://www.inngest.com/discord)!**_

## Usage

```js
// ES Modules / TypeScript
import { Inngest } from "inngest";
// or CommonJS
const { Inngest } = require("inngest");

const inngest = new Inngest(process.env.INNGEST_SOURCE_API_KEY);

// Send a single event
await inngest.send({
  name: "user.signup",
  data: {
    plan: account.planType,
  },
  user: {
    external_id: user.id,
    email: user.email,
  },
});

// Send events in bulk
const events = ["+12125551234", "+13135555678"].map(phoneNumber => ({
  name: "sms.response.requested",
  data: {
    message: "Are you available for work today? (y/n)"
  },
  user: {
    phone: phoneNumber
  }
}});
await inngest.send(events);
```

## Contributing

Clone the repository, then:

```sh
yarn # install dependencies
yarn dev # build/lint/test
```

We use [Volta](https://volta.sh/) to manage Node/Yarn versions.

When making a pull request, make sure to commit the changed `etc/inngest.api.md` file; this is a generated types/docs file that will highlight changes to the exposed API.
