---
"inngest": minor
---

`inngest/experimental/agents/testing` publishes the pieces of the agents e2e kit that an app's own tests need, so apps stop copying them: `script()`, a scripted model that needs no API key (steps answer by turn or by `when`, `{{last}}` echoes the last user message); `fakeSandbox()`, the Sandboxes API served from memory as a `fetch` for the Inngest client, with canned commands, uploaded files, snapshots and real local git in directories you name; `startFakes()`, a local server that plays Slack and GitHub and records every call (`posts({ channel, method, thread })`); `startGitRemote(token)`, a real `git http-backend` behind a token; and `withKeys()`, a thread handle whose `state()` returns the keys the agent set. They run in Node and are for tests only. The repo's own e2e kit now imports them from this entry.

```ts
import { fakeSandbox, script, startFakes } from "inngest/experimental/agents/testing";

const fakes = await startFakes();
const client = new Inngest({
  id: "app",
  fetch: fakeSandbox({ recordUrl: fakes.url, commands: { "npm test": { stdout: "ok" } } }).fetch,
});
// agent.loop({ model: script([{ call: { name: "run", input: {} } }, { say: "done" }]), ... })
// fakes.posts({ channel: "sandbox", method: "sandbox.exec" })
```
