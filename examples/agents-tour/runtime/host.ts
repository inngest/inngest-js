/**
 * @module
 * The app the tour runs for the learner. It imports the page's files, which
 * `TOUR_FILES` lists, from `TOUR_DIR`; the files together export `client` and
 * `agents`. It serves the agents over HTTP the way any app would, plus one
 * tour-owned function, and answers a few tour-only routes: health, the agents
 * it found, "start an agent" and "send a message to a thread".
 *
 * Run imports the page's `run.ts`, whose top-level code calls
 * `agent.start()`, or starts an agent from a manifest start entry.
 * `start()` only works inside a function, so the host registers `tour-start`
 * (triggered by `tour/start`) to do either. `run.ts` is imported afresh on
 * every call of `tour-start`, never at load, so its top-level code runs
 * inside the function each time, against the same agents the host serves. A run opened by `start()` ends after its answer. The tour
 * hides `tour-start` from the runs it shows. A message to a thread is the
 * plain `agent/message` event, sent from here.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Inngest } from "inngest";
import { agentMessage, type Json } from "inngest/experimental/agents";
import { serve } from "inngest/node";
import { describeRuntimeError } from "../shared/problems.ts";

interface StartableAgent {
  id: string;
  address: string;
  start(input: Json, options?: { thread?: string }): Promise<unknown>;
  thread(key: string): unknown;
}

// The event that asks `tour-start` to start an agent.
const tourStartEvent = "tour/start";

interface Target {
  agent: string;
  thread: string;
  content: Json;
}

const dir = process.env.TOUR_DIR ?? "";

const names = JSON.parse(process.env.TOUR_FILES ?? "[]") as string[];
// By export name and by agent id: the manifests name agents by id.
const found = new Map<string, StartableAgent>();
let client: Inngest.Any | undefined;
let agents: unknown;
// The page's `run.ts`, if it has one: what Run runs.
const runFile = names.includes("run.ts")
  ? pathToFileURL(join(dir, "run.ts")).href
  : undefined;
let runs = 0;

for (const name of names.filter((one) => one !== "run.ts")) {
  const loaded = (await import(pathToFileURL(join(dir, name)).href)) as Record<
    string,
    unknown
  >;

  client ??= loaded.client as Inngest.Any | undefined;
  agents ??= loaded.agents;

  for (const [exported, value] of Object.entries(loaded)) {
    const candidate = value as Partial<StartableAgent> | undefined;

    if (
      candidate &&
      typeof candidate.thread === "function" &&
      typeof candidate.start === "function"
    ) {
      found.set(exported, candidate as StartableAgent);

      if (typeof candidate.id === "string") {
        found.set(candidate.id, candidate as StartableAgent);
      }
    }
  }
}

if (!client || !agents) {
  throw new Error(
    `The page's files (${names.join(", ")}) must export client and agents`,
  );
}

const app = client;

const agentOf = (name: string) => {
  const agent = found.get(name);

  if (!agent) {
    throw new Error(
      `No exported agent named "${name}" (found: ${[...new Set(found.values())].map((one) => one.id).join(", ") || "none"})`,
    );
  }

  return agent;
};

const tourStart = app.createFunction(
  { id: "tour-start", retries: 0, triggers: [{ event: tourStartEvent }] },
  async ({ event }) => {
    if ((event.data as { runFile?: boolean }).runFile) {
      if (!runFile) {
        throw new Error("The page has no run.ts");
      }

      // A new URL each time makes Node evaluate `run.ts` again; the files it
      // imports keep their URLs, so they stay the modules served here.
      runs += 1;

      try {
        await import(`${runFile}?run=${runs}`);
      } catch (error) {
        // Tell the tour at once, so the Trace does not wait for a run that
        // will never come.
        const text =
          error instanceof Error
            ? `${error.message}\n${error.stack ?? ""}`
            : String(error);

        process.send?.({
          type: "tour-run",
          failure: describeRuntimeError(text, names, "run.ts"),
        });

        throw error;
      }

      process.send?.({ type: "tour-run" });

      return { ran: "run.ts" };
    }

    const target = event.data as Target;

    await agentOf(target.agent).start(target.content, {
      thread: target.thread,
    });

    return { started: target.agent, thread: target.thread };
  },
);

const inngest = serve({
  client: app,
  functions: [
    ...(
      agents as { functions: () => Parameters<typeof serve>[0]["functions"] }
    ).functions(),
    tourStart,
  ],
});

const readBody = async (req: import("node:http").IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const json = (
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const routes: Record<string, (target: Target) => Promise<unknown>> = {
  // Run on a page with `run.ts`: `tour-start` imports and so runs it.
  "/__tour/run": async () => {
    if (!runFile) {
      throw new Error("The page has no run.ts");
    }

    return app.send({ name: tourStartEvent, data: { runFile: true } });
  },
  // Run: `tour-start` calls `agent.start(content, { thread })`.
  "/__tour/start": async (target) => {
    agentOf(target.agent);

    return app.send({ name: tourStartEvent, data: target });
  },
  // A message to a thread: into the live run's inbox, or a new run.
  "/__tour/send": async (target) => {
    const agent = agentOf(target.agent);

    return app.send(
      agentMessage.create({
        agent: agent.address,
        thread: target.thread,
        content: target.content,
      }),
    );
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://host");

  if (url.pathname === "/__tour/health") {
    json(res, 200, {
      ok: true,
      agents: [...new Set(found.values())].map((agent) => {
        return agent.id;
      }),
    });

    return;
  }

  const route = routes[url.pathname];

  if (route && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as Target;
      let status = 200;
      let result: unknown = { ok: true };

      try {
        await route(body);
      } catch (error) {
        const missing = String(error).includes("No exported agent");

        status = missing ? 404 : 500;
        result = { error: missing ? (error as Error).message : String(error) };
      }

      json(res, status, result);
    } catch (error) {
      json(res, 400, { error: String(error) });
    }

    return;
  }

  return inngest(req, res);
});

server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  process.send?.({ type: "ready" });
});

// If the tour server dies without cleaning up, do not outlive it.
process.on("disconnect", () => {
  process.exit(0);
});
