---
"inngest": minor
---

Add support for Fastify, either via a custom `.route()` or using a Fastify plugin

```ts
import Fastify from "fastify";
import inngestFastify, { serve } from "inngest/fastify";
import { functions, inngest } from "./inngest";

const fastify = Fastify({
  logger: true,
});

// The lead maintainer of Fastify recommends using this as a plugin:
fastify.register(inngestFastify, {
  client: inngest,
  functions,
  options: {},
});

// We do also export `serve()` if you want to use it directly, though.
fastify.route({
  method: ["GET", "POST", "PUT"],
  handler: serve(inngest, functions),
  url: "/api/inngest",
});

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
```
