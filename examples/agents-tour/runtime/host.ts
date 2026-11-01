/**
 * @module
 * The app the tour runs for the learner. It imports the page's files, which
 * `TOUR_FILES` lists, from `TOUR_DIR`; the files together export `client` and
 * `agents`. It serves the agents over HTTP the way any app
 * would, and answers a few tour-only routes: health, the agents it found, and
 * "send a message to a thread", which uses the agent's own thread handle.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "inngest/node";

interface ThreadSender {
  thread(key: string): { send(message: string): Promise<void> };
}

const dir = process.env.TOUR_DIR ?? "";

const names = JSON.parse(process.env.TOUR_FILES ?? "[]") as string[];
const senders = new Map<string, ThreadSender>();
let client: unknown;
let agents: unknown;

for (const name of names) {
  const loaded = (await import(pathToFileURL(join(dir, name)).href)) as Record<
    string,
    unknown
  >;

  client ??= loaded.client;
  agents ??= loaded.agents;

  for (const [exported, value] of Object.entries(loaded)) {
    const candidate = value as Partial<ThreadSender> | undefined;

    if (candidate && typeof candidate.thread === "function") {
      senders.set(exported, candidate as ThreadSender);
    }
  }
}

if (!client || !agents) {
  throw new Error(
    `The page's files (${names.join(", ")}) must export client and agents`,
  );
}

const inngest = serve({
  client: client as Parameters<typeof serve>[0]["client"],
  functions: (
    agents as { functions: () => Parameters<typeof serve>[0]["functions"] }
  ).functions(),
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://host");

  if (url.pathname === "/__tour/health") {
    json(res, 200, { ok: true, agents: [...senders.keys()] });

    return;
  }

  if (url.pathname === "/__tour/send" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        agent: string;
        thread: string;
        message: string;
      };
      const sender = senders.get(body.agent);

      if (!sender) {
        json(res, 404, {
          error: `No exported agent named "${body.agent}" (found: ${[...senders.keys()].join(", ") || "none"})`,
        });

        return;
      }

      await sender.thread(body.thread).send(body.message);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 500, { error: String(error) });
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
