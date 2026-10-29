/**
 * @module
 * The app the tour runs for the learner. It loads the lesson's `setup.ts` and
 * `agent.ts` from `TOUR_DIR`, serves the agents over HTTP the way any app
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

const setup = await import(pathToFileURL(join(dir, "setup.ts")).href);
const lesson = await import(pathToFileURL(join(dir, "agent.ts")).href);

const senders = new Map<string, ThreadSender>();

for (const [name, value] of Object.entries(lesson)) {
  const candidate = value as Partial<ThreadSender> | undefined;

  if (candidate && typeof candidate.thread === "function") {
    senders.set(name, candidate as ThreadSender);
  }
}

const inngest = serve({
  client: setup.client,
  functions: setup.agents.functions(),
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
