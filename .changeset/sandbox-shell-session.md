---
"inngest": minor
---

A sandbox can now keep a working directory and environment between commands, like a terminal. `sandbox.shell({ cwd, env })` gives a `$` where `cd` and `export` in one command apply to every command called after it finishes, and `sh.cwd` and `sh.env` read the current state. Commands called together still run in parallel, each from the state when it was called.

```ts
const sh = sandbox.shell({ cwd: "/work" });

await sh.$`cd app`;
await sh.$`export NODE_ENV=test`;
await sh.$`npm test`; // runs in /work/app with NODE_ENV=test
```

The `run` tool of `sandbox.tools.code()` is now a shell session by default, so a model that runs `cd pkg` finds itself there on its next call, and the result says where a command moved it. Pass `session: false` to start every command fresh as before. Only the directory and exported variables carry over; functions, aliases and unexported variables do not.
