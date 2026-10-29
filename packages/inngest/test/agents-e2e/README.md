# Agents e2e kit

One way to verify a piece of the agent primitives before it is squash-merged into `jack/agent-primitives`. Every piece agent follows this file.

The kit fakes everything that is not under test: the model is scripted, Slack, GitHub and the Sandboxes API are fakes that record every call. Redis and the Dev Server are real. There is no live rung: no model key, no real Sandboxes.

This machine is NixOS: a missing binary runs one-off with `, <cmd>` (for example `, sqlite3`, `, python3`, `, flyctl`). Never hunt in `/nix/store` and never skip a check because a tool is missing.

## The verify ladder

Run in order from the repo root; stop at the first failure. Merge the current `origin/jack/agent-primitives` into your branch first (merge, never rebase).

```sh
pnpm install && pnpm build                       # once per worktree; builds dist, which the kit imports
pnpm -C packages/inngest test agent              # 1. unit
pnpm -C packages/inngest test:types              # 2. types (includes the kit)
pnpm -C packages/inngest lint                    #    lint
pnpm -C packages/inngest build                   #    build (the kit runs against dist, rebuild after SDK changes)
pnpm agents:examples                             #    biome and tsc for every examples/agents-* and coding-agent; installs each against the built dist, so build first
pnpm agents:verify <scenario>                    # 3. your scenario(s), 30-60s each
pnpm agents:verify --all                         # 4. the whole suite, required before squash
```

A piece that changes run behaviour, KV, inbox, subscribe, channels or sandboxes needs a scenario. A types or docs only piece says "no scenario needed" in its PR.

Scenarios share one stack per `agents:verify` call (Dev Server, Redis, the kit app). The stack is named from the branch and scenarios plus a random suffix (`verify-<branch>-<scenarios>-<hash>-<random>`), so no two runs collide, even on one branch. With devstack, everything runs inside `devstack with --timeout`, so a crash cannot leak a stack (not with `--keep`, which leaves the stack up on purpose). The direct stack has its own time cap and stops its processes on SIGINT and SIGTERM. Flags: `--bin local@<sha>` to pick the Dev Server build, `--keep` to leave the devstack stack up for debugging (then `devstack stop <name>`; the fakes stop with the CLI, so only runs and the Dev Server UI are useful; not available with the direct stack).

## Adding a scenario

One file in `scenarios/`, named by its id. The CLI and the app find it by the file name; export it with a named export. `functions` runs inside the app; `run` runs in the CLI.

```ts
// packages/inngest/test/agents-e2e/scenarios/my-piece.ts
import { agent } from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";

export const myPiece = scenario({
  id: "my-piece",
  owner: "agents-x",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "my-piece-fn", triggers: [{ event: event("go") }] },
        async () => {
          const result = await agent.loop({
            model: script([{ say: "echo: {{last}}" }]),
            prompt: "hi",
            tools: {},
          });

          return { text: result.text };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(await ctx.send("go", {}, { startsRun: true }));

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toHaveSteps("agent:model:1");
    ctx.expect.run(run).toOutput({ text: "echo: hi" });
  },
});
```

The driver (`kit/driver.ts`, the `ctx` your `run` gets):

- `ctx.send(name, data, { startsRun })` sends the scenario's event `agents-e2e/<id>/<name>` (use `event(name)` in `functions`) and returns the event ID; pass `startsRun: true` for an event whose run you wait for with `finished`, so it is resent once if no run starts. `ctx.finished(eventId)` waits for its run to end.
- `ctx.expect.run(run)`: `toComplete()`, `toHaveSteps(...ids)` (the IDs your function gave them, such as `agent:model:1`), `toOutput(value)`.
- `ctx.expect.kv(key).toEqual(value)` reads a Redis key (JSON) of the real Redis.
- `ctx.expect.posts({ channel, method, thread }).toHaveCount(n)` (exactly n, after a 1s settle) and `.toInclude({ field: value })` assert on the calls the fake channels got since your scenario began. Slack posts to `${fakes.url}/slack/api/<method>` (`chat.postMessage`, `chat.update`, `reactions.add`, thread in `thread_ts`); GitHub to `${fakes.url}/github/repos/<o>/<r>/issues/<n>/comments` or `.../pulls/<n>/reviews`. The thread of a GitHub call is `owner/repo#n`.
- `ctx.restartApp()` kills the app process and starts it again (Dev Server and Redis stay), returning once it has synced; requests in flight are lost, as in a worker crash or deploy.
- `ctx.eventually(name, read, ok)`, `ctx.until(read, ok)`, `ctx.check(name, ok, detail)` for anything else. Poll with `until`; never `sleep` over 3s and never assert on wall-clock time.
- `script([...])` is the scripted model: steps answer by turn (`{ say }` or `{ call: { name, input } }`), a step with `when(request)` answers the first request it matches, and the model echoes after the script.
- `sandbox: "fake"` serves the Sandboxes API from memory (see `scenarios/sandbox-fake.ts`); `sandboxCommands` cans command output. Operations show up as `channel: "sandbox"` calls (`sandbox.create`, `sandbox.exec`, `sandbox.upload`, `sandbox.destroy`).

Limits: the fake Slack and GitHub answer only the write methods listed (everything else is a 404 or a minimal `{ ok: true }`); `sandboxCommands` of all scenarios in one run are merged, so keep command keys specific.

Rules: a scenario uses its own event names and thread IDs (the driver gives you the event prefix); one retry is not allowed, a flaky scenario is a bug and blocks merges; 2 minute cap, aim for 30-60s.

## Needing a local OSS build

If your piece needs a backend change not in the published Dev Server, declare it:

```ts
export const myPiece = scenario({ id: "my-piece", needs: { oss: "jack/step-subscribe" }, ... });
```

`kit/oss-pins.json` maps that branch to a sha. `run.ts` runs `devstack build-local ~/repo/inngest/inngest --ref <sha>` (cached per commit) and starts the Dev Server with `--bin local@<sha>`. Only the integration owner edits `oss-pins.json`, so everyone verifies against the same backend. Delete the pin when the published CLI has the feature. Two scenarios that need different pins cannot run in one `--all`; the CLI says so.

## CI

Pushes to `jack/agent-primitives` run unit, types, lint and `agents:verify --all` as an `@inngest/ci` pipeline (`ci/pipelines/agents.ts` on `jack/ci-worker`). CI has no devstack, so it uses the kit's direct stack: `AGENTS_VERIFY_STACK=direct AGENTS_VERIFY_DEV_BIN=<path to the Dev Server> pnpm agents:verify --all` (`AGENTS_VERIFY_REDIS_CMD` overrides the Redis command, `AGENTS_VERIFY_VERBOSE=1` shows process output). The author of the latest squash fixes or reverts a red run.

## What to paste in your report

- The commands you ran and their final lines: the unit `Test Files ... passed` line, `test:types`, `lint` and `build` exit status, and the `PASS ...` lines of `pnpm agents:verify <scenario>` plus the final `agents:verify PASSED`.
- For the squash: the `pnpm agents:verify --all` output on the merged tree (all `PASS` lines, `agents:verify PASSED`).
- The Dev Server build line (`stack ... Dev Server published|local@sha`).
- Any scenario you added or changed, and "no scenario needed" with the reason if you added none.
