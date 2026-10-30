---
"inngest": minor
---

`inngest/experimental/agents/testing` publishes the pieces of the agents e2e kit that an app's own tests need, so apps stop copying them: `script()`, a scripted model that needs no API key (steps answer by turn or by `when`, `{{last}}` echoes the last user message); `fakeSandbox()`, the Sandboxes API served from memory as a `fetch` for the Inngest client, with canned commands, uploaded files, snapshots and real local git in directories you name; `startFakes()`, a local server that plays Slack and GitHub and records every call (`posts({ channel, method, thread })`); `startGitRemote(token)`, a real `git http-backend` behind a token; and `withKeys()`, a thread handle whose `state()` returns the keys the agent set. They run in Node and are for tests only. The repo's own e2e kit imports them from this entry.

The fakes clean up after themselves: `fakeSandbox()`, `startFakes()` and `startGitRemote()` have `close()` and work with `await using`; closing the sandbox kills the processes the agent started and removes its temp directory, and closing the git remote removes the repository. `fakeSandbox({ fakes })` records on a fakes server of the same process, so `posts()` is complete the moment the sandbox answers (`recordUrl` posts to one in another process and waits for it). A command that no entry of `commands` matches fails with exit code 127 and says so on stderr, so a typo never passes by silence; the key `""` matches any command. An unknown path of the Sandboxes API (`/v2/...`) is a 404, never a request to the network. Nothing is looked up when the entry is imported.

```ts
import { fakeSandbox, script, startFakes } from "inngest/experimental/agents/testing";

await using fakes = await startFakes();
await using sandbox = fakeSandbox({ fakes, commands: { "npm test": { stdout: "ok" }, "": {} } });
const client = new Inngest({ id: "app", fetch: sandbox.fetch });
// agent.loop({ model: script([{ call: { name: "run", input: {} } }, { say: "done" }]), ... })
// fakes.posts({ channel: "sandbox", method: "sandbox.exec" })
```
