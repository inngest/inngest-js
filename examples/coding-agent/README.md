# Coding agent

Send an `agent/task` event with a repository and a task; a branch and a pull request come out. The agent works in a Cloud sandbox: it reads and edits the code, runs commands, and when it is happy it pushes a branch and opens a pull request. Every model call and every tool call is a step, so a crash never repeats work and the trace shows each turn.

- [`agent.ts`](agent.ts) is the whole function. It uses `repo()` to check the code out, `codeTools()` for read, write, edit, search and run, `agent.loop()` for the loop, and its own `openPullRequest` tool.
- [`model.ts`](model.ts) plugs Claude into the loop with `@anthropic-ai/sdk`. `agent.loop()` has no provider built in: `model` is a function you write that calls whichever SDK you use, so any provider plugs in the same way.

The GitHub token never enters the sandbox. `repo()` passes it only in the environment of the clone and push commands, and `openPullRequest` runs in your app.

## Run it

```sh
pnpm install
export ANTHROPIC_API_KEY=... GITHUB_TOKEN=...
pnpm start
```

Start a Dev Server (`npx inngest-cli dev -u http://localhost:3940/api/inngest`), then send an event from its dashboard:

```json
{ "name": "agent/task", "data": { "repo": "owner/name", "task": "Add a --version flag" } }
```

## Long sessions

This example is one run per task. For a conversation, run one function per thread: keep the messages in a durable log (a database, a Slack thread, pull request comments) and loop, passing each result's `history` to the next call.

```ts
let history: AgentMessage[] = [];

for (let round = 0; ; round += 1) {
  const messages = await step.run(`read:${round}`, () => thread.next());

  const result = await agent.loop({
    id: `round-${round}`,
    model: claude,
    history,
    prompt: messages.join("\n"),
    tools,
    steer: async (turn) => {
      return step.run(`steer:${round}.${turn}`, () => thread.next());
    },
  });

  history = result.history;
}
```

`steer` runs between model calls, so a message sent mid-task reaches the model on its next turn. Read it from a durable log: an event alone can be missed.
