---
"inngest": minor
---

You can now hand your sandbox tools straight to a model with `toolDefinitions(tools)`. It returns each tool's name, description and JSON Schema in the shape Anthropic's `tools` parameter takes, with no need to convert Zod schemas yourself.

```ts
import { toolDefinitions } from "inngest/experimental";

await anthropic.messages.create({
  model,
  max_tokens: 1024,
  messages,
  tools: toolDefinitions({ getCustomer }),
});
```
