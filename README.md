# inngest-node

```
npm install inngest
```

## Usage

```js
// ES Modules / TypeScript
import { Inngest } from "inngest";
// or CommonJS
const { Inngest } = require("inngest");

const inngest = new Inngest(process.env.INNGEST_SOURCE_API_KEY);

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
```
