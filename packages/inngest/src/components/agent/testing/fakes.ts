/**
 * @module
 * EXPERIMENTAL: one in-process HTTP server that plays the recorder the fake
 * sandbox and the scripted model report to, and the commits API a repo sync
 * reads. Every call is kept, so a test asserts on what the agents did.
 */
import { createServer, type IncomingMessage } from "node:http";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";

/**
 * One call the fakes server received.
 */
export interface Call {
  /**
   * Which fake received the call.
   */
  channel: "sandbox" | "model";

  /**
   * What was called, such as `sandbox.exec`.
   */
  method: string;

  /**
   * The request body, parsed as JSON or as a form.
   */
  body: Record<string, unknown>;
}

/**
 * Which calls `posts()` returns: those that match every field given.
 */
export interface CallFilter {
  /**
   * Only calls of this fake.
   */
  channel?: Call["channel"];

  /**
   * Only calls of this method.
   */
  method?: string;
}

/**
 * The running fakes server and what it recorded.
 */
export interface Fakes {
  /**
   * The server's base URL, such as `http://127.0.0.1:41233`.
   */
  url: string;

  /**
   * Every call received, oldest first.
   */
  calls: Call[];

  /**
   * The calls that match every field of `filter`, oldest first.
   */
  posts: (filter?: CallFilter) => Call[];

  /**
   * Records a sandbox operation, as `fakeSandbox({ fakes })` does in this
   * process.
   */
  record: (method: string, body: Record<string, unknown>) => void;

  /**
   * Stops the server and drops its connections.
   */
  close: () => Promise<void>;

  /**
   * Same as `close()`, for `await using fakes = await startFakes()`.
   */
  [Symbol.asyncDispose]: () => Promise<void>;
}

const readBody = async (
  req: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  if (!text) {
    return {};
  }

  if (
    req.headers["content-type"]?.includes("application/x-www-form-urlencoded")
  ) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  return JSON.parse(text) as Record<string, unknown>;
};

/**
 * Starts the fakes server on a free local port. Point the fake sandbox's
 * `recordUrl` at `url`, and read
 * what the agents did from `calls` or `posts()`. Close it when the test ends.
 */
export const startFakes = async (): Promise<Fakes> => {
  const calls: Call[] = [];
  const commits = new Map<string, string>();

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const body = await readBody(req).catch((): Record<string, unknown> => {
      return {};
    });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };

    // The commit a ref points at, for scenarios that resolve a ref to a sha:
    // GET answers like the GitHub commits API; PUT sets it, body { sha }.
    const commit = path.match(
      /^\/github\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/,
    );

    if (commit) {
      const key = `${commit[1]}@${decodeURIComponent(commit[2] as string)}`;

      if (req.method === "PUT") {
        commits.set(key, String(body.sha));
        reply(200, { ok: true });
      } else if (commits.has(key)) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(commits.get(key));
      } else {
        reply(404, { message: "Not Found" });
      }

      return;
    }

    // A scripted model in another process reports each request it was shown:
    // the method is the model's name, the body is the request.
    const model = path.match(/^\/model\/([^/]+)$/);

    if (model && req.method === "POST") {
      calls.push({
        channel: "model",
        method: decodeURIComponent(model[1] as string),
        body,
      });
      reply(200, { ok: true });

      return;
    }

    if (path === "/record" && req.method === "POST") {
      calls.push({
        channel: "sandbox",
        method: String(body.method),
        body,
      });
      reply(200, { ok: true });

      return;
    }

    reply(404, { error: `fakes serve no ${req.method} ${path}` });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("The fakes server has no port");
  }

  const close = () => {
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  };

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    record: (method, body) => {
      calls.push({ channel: "sandbox", method, body: { method, ...body } });
    },
    posts: (filter = {}) => {
      return calls.filter((call) => {
        return (
          (!filter.channel || call.channel === filter.channel) &&
          (!filter.method || call.method === filter.method)
        );
      });
    },
    close,
    [asyncDispose]: close,
  };
};
