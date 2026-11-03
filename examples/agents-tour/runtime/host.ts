/**
 * @module
 * The app the tour runs for the learner. It imports the page's files, which
 * `TOUR_FILES` lists, from `TOUR_DIR`; the files together export `client` and
 * `agents`. It serves the agents over HTTP the way any app would, plus one
 * tour-owned function, and answers a few tour-only routes: health, the agents
 * it found, "start an agent" and "send a message to a thread".
 *
 * Run calls the `run` export of the page's `run.ts`, or starts an agent from
 * a manifest start entry with `agent.start()`. `start()` only works inside a
 * function, so the host registers `tour-start` (triggered by `tour/start`) to
 * make either call. A run opened by `start()` ends after its answer. The tour
 * hides `tour-start` from the runs it shows. A message to a thread is the
 * plain `agent/message` event, sent from here.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Inngest } from "inngest";
import { agentMessage, type Json } from "inngest/experimental/agents";
import { serve } from "inngest/node";

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
// The `run` export of the page's `run.ts`: what Run runs.
let runFile: (() => Promise<unknown>) | undefined;

for (const name of names) {
  const loaded = (await import(pathToFileURL(join(dir, name)).href)) as Record<
    string,
    unknown
  >;

  client ??= loaded.client as Inngest.Any | undefined;
  agents ??= loaded.agents;

  if (name === "run.ts" && typeof loaded.run === "function") {
    runFile = loaded.run as () => Promise<unknown>;
  }

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
        throw new Error("The page has no run.ts exporting run");
      }

      await runFile();

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
  // Run on a page with `run.ts`: `tour-start` calls its `run` export.
  "/__tour/run": async () => {
    if (!runFile) {
      throw new Error("The page has no run.ts exporting run");
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
