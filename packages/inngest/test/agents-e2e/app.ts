/**
 * @module
 * The one Inngest app of the kit. It serves the functions of every scenario
 * named in `AGENTS_E2E_SCENARIOS`, with the fake Sandboxes API when a scenario
 * asks for it. Started by `run.ts` through devstack.
 */
import { writeFileSync } from "node:fs";
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
const commands = Object.assign({}, ...scenarios.map((s) => s.sandboxCommands));

export const client = new Inngest({
  id: "agents-e2e",
  middleware: [sandboxMiddleware()],
  ...(fakeSandboxes
    ? {
        fetch: fakeSandbox({
          recordUrl: fakesUrl,
          // The scenarios drive the SDK's tool runners and real git with a
          // scripted model.
          execute: "local",
          // A command no scenario names succeeds with no output.
          commands: { ...commands, "": {} },
          localDirs,
        }).fetch,
      }
    : {}),
});

// Scenarios each make agents on the one client, and each instance lists the
// client's shared bake function, so repeats are dropped.
const listed = scenarios.flatMap((s) => {
  return s.functions({
    client,
    fakes: { url: fakesUrl },
    redisUrl: process.env.INNGEST_EXPERIMENTAL_KV_URL,
    event: (name) => {
      return eventName(s.id, name);
    },
  });
});
const functions = [...new Set(listed)];

const others = scenarios.flatMap((s) => {
  return (
    s.apps?.({
      client,
      fakes: { url: fakesUrl },
      redisUrl: process.env.INNGEST_EXPERIMENTAL_KV_URL,
      event: (name) => {
        return eventName(s.id, name);
      },
    }) ?? []
  );
});
const handlers = others.map((other) => {
  const path = `/api/inngest/${other.client.id}`;

  return {
    path,
    handler: serve({
      client: other.client,
      functions: other.functions,
      servePath: path,
    }),
  };
});
const mainHandler = serve({ client, functions });

createServer((req, res) => {
  const other = handlers.find((entry) => {
    return req.url?.startsWith(entry.path);
  });

  return (other?.handler ?? mainHandler)(req, res);
}).listen(Number(process.env.PORT), () => {
  // Each other app syncs itself to the Dev Server when it is sent a PUT.
  for (const { path } of handlers) {
    void fetch(`http://127.0.0.1:${process.env.PORT}${path}`, {
      method: "PUT",
    });
  }

  // The CLI waits for the Dev Server to know these before it runs anything.
  const file = process.env.AGENTS_E2E_EXPECT_FILE;

  if (file) {
    writeFileSync(
      file,
      JSON.stringify([
        ...functions.map((fn) => {
          return fn.id(client.id);
        }),
        ...others.flatMap((other) => {
          return other.functions.map((fn) => {
            return fn.id(other.client.id);
          });
        }),
      ]),
    );
  }
});
