/**
 * @module
 * The one Inngest app of the kit. It serves the functions of every scenario
 * named in `AGENTS_E2E_SCENARIOS`, with the fake Sandboxes API when a scenario
 * asks for it. Started by `run.ts` through devstack.
 */
import { createServer } from "node:http";
import { Inngest } from "inngest";
import { sandboxMiddleware } from "inngest/experimental";
import { serve } from "inngest/node";
import { eventName, type Scenario } from "./kit/driver.ts";
import { fakeSandbox } from "./kit/sandbox.ts";

const ids = (process.env.AGENTS_E2E_SCENARIOS ?? "").split(",").filter(Boolean);
const fakesUrl = process.env.AGENTS_E2E_FAKES ?? "";

const scenarios: Scenario[] = [];

for (const id of ids) {
  const module = (await import(`./scenarios/${id}.ts`)) as Record<
    string,
    unknown
  >;
  const found = Object.values(module).find((value) => {
    return (value as Scenario | undefined)?.id === id;
  });

  if (!found) {
    throw new Error(`scenarios/${id}.ts exports no scenario with id "${id}"`);
  }

  scenarios.push(found as Scenario);
}

const fakeSandboxes = scenarios.some((s) => {
  return s.sandbox === "fake";
});
const localDirs = scenarios.flatMap((s) => {
  return s.sandboxLocalDirs ?? [];
});
const snapshotLimit = scenarios.find((s) => {
  return s.sandboxSnapshotLimit;
})?.sandboxSnapshotLimit;
const commands = Object.assign({}, ...scenarios.map((s) => s.sandboxCommands));

export const client = new Inngest({
  id: "agents-e2e",
  middleware: [sandboxMiddleware()],
  ...(fakeSandboxes
    ? {
        fetch: fakeSandbox({
          recordUrl: fakesUrl,
          commands,
          localDirs,
          ...(snapshotLimit ? { snapshotLimit } : {}),
        }).fetch,
      }
    : {}),
});

const functions = scenarios.flatMap((s) => {
  return s.functions({
    client,
    fakes: { url: fakesUrl },
    redisUrl: process.env.INNGEST_EXPERIMENTAL_KV_URL,
    event: (name) => {
      return eventName(s.id, name);
    },
  });
});

createServer(serve({ client, functions })).listen(Number(process.env.PORT));
