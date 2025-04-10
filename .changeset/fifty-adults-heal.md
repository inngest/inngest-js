---
"inngest": minor
---

Adds a `fetch` export from `"inngest"` to allow any library that accepts a Fetch API-compatible function to automatically turn any call into a durable step if used within the context of an Inngest Function.

By default, if called outside of the context of an Inngest Function (or within an existing step), it will fall back to using the global `fetch`, or a fallback of the user's choice.

```ts
// Basic use
import { fetch } from "inngest";

const api = new MyProductApi({ fetch });
```

```ts
// With a fallback
import { fetch } from "inngest";

const api = new MyProductApi({
  fetch: fetch.config({
    fallback: myCustomFetchFallback,
  }),
});
```

```ts
// Remove the default fallback and error if called outside an Inngest Function
import { fetch } from "inngest";

const api = new MyProductApi({
  fetch: fetch.config({
    fallback: undefined,
  }),
});
```

It's also available within a function as `step.fetch`.

```ts
inngest.createFunction({
  id: "my-fn",
}, {
  event: "my-event",
}, async ({ step }) => {
  const api = new MyProductApi({ fetch: step.fetch });
});
```
