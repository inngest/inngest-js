---
"inngest": patch
---

`agent.loop()` now gives up at once when the model rejects a request in a way no retry can fix (a 400, 401, 403, 404 or 422, but not 408, 409 or 429), instead of retrying it until the run dies. The same check is `agent.classifyModelError(error)`, for a loop of your own: throw what it returns. A 429, a 5xx and an overloaded error still retry. `agent.untrusted(text, { source })` wraps text from outside (an issue, a web page, a tool's output) in `<untrusted>` tags that your prompt can name; nothing applies it for you.

```ts
return agent.untrusted(issue.body, { source: `issue #${number}` });
```
