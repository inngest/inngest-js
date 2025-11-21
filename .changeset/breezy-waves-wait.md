---
"inngest": minor
---

Add async checkpointing to functions and clients. Only allows checkpointing after every step (`maxSteps: 1`) currently.

Can be enabled on the client:
```ts
import { Inngest } from "inngest";

const inngest = new Inngest({
  id: "...",
  experimentalCheckpointing: true,
});
```
...or on each function...
```ts
inngest.createFunction({
  id: "...",
  experimentalCheckpointing: true,
}, {
  event: "demo/event.sent",
}, async ({ event, step }) => {
  // ...
});
```
