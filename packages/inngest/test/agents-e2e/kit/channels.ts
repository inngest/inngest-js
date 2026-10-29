/**
 * @module
 * One in-process HTTP server that plays the fake Slack, the fake GitHub and
 * the recorder the fake sandbox reports to. Every call is kept, so a
 * scenario asserts on what the agents posted. The shapes follow the Slack Web
 * API (`chat.postMessage`, `chat.update`, `reactions.add`, Block Kit actions
 * for ask buttons) and the GitHub REST API (issue comments, PR reviews).
 */
import { createServer, type IncomingMessage } from "node:http";

export interface Call {
  channel: "slack" | "github" | "sandbox";

  /**
   * What was called, such as `chat.postMessage`, `issues.createComment` or
   * `sandbox.exec`.
   */
  method: string;

  /**
   * The conversation the call belongs to: the Slack thread timestamp, or
   * `owner/repo#number` for GitHub.
   */
  thread?: string;
  body: Record<string, unknown>;
}

export interface CallFilter {
  channel?: Call["channel"];
  method?: string;
  thread?: string;
}

export interface Fakes {
  url: string;
  calls: Call[];

  /**
   * The calls that match every field of `filter`, oldest first.
   */
  posts: (filter?: CallFilter) => Call[];
  close: () => Promise<void>;
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

export const startFakes = async (): Promise<Fakes> => {
  const calls: Call[] = [];
  const commits = new Map<string, string>();
  const streams = new Map<string, { ids: Set<string>; over: boolean }>();
  let counter = 0;

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const body = await readBody(req).catch((): Record<string, unknown> => {
      return {};
    });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };

    counter++;

    const slack = path.match(/^\/slack\/api\/(.+)$/);

    if (slack) {
      const method = slack[1] as string;
      const ts = `${1_700_000_000 + counter}.${String(counter).padStart(6, "0")}`;
      const thread = String(body.thread_ts ?? body.timestamp ?? body.ts ?? ts);

      // Streamed progress, with Slack's rules: a stream holds 50 unique task
      // cards (a 51st is dropped and Slack answers ok with a warning), and a
      // stream is over once it is stopped or a card named end-stream was
      // written (the next write gets message_not_in_streaming_state).
      if (method === "chat.startStream") {
        streams.set(ts, { ids: new Set(), over: false });
      }

      if (method === "chat.stopStream") {
        const stopped = streams.get(String(body.ts));

        if (stopped) {
          stopped.over = true;
        }
      }

      if (method === "chat.appendStream") {
        const stream = streams.get(String(body.ts));
        const chunks = (body.chunks ?? []) as { id: string }[];

        if (!stream || stream.over) {
          calls.push({
            channel: "slack",
            method,
            thread: String(body.ts),
            body: { ...body, accepted: false },
          });
          reply(200, { ok: false, error: "message_not_in_streaming_state" });

          return;
        }

        for (const chunk of chunks) {
          stream.ids.add(chunk.id);

          if (chunk.id === "end-stream") {
            stream.over = true;
          }
        }

        const dropped = stream.ids.size > 50;

        calls.push({
          channel: "slack",
          method,
          thread: String(body.ts),
          body: { ...body, accepted: !dropped, held: stream.ids.size },
        });
        reply(200, {
          ok: true,
          ...(dropped
            ? {
                warning: "missing_charset",
                response_metadata: {
                  warnings: ["missing_charset"],
                  messages: [
                    "[WARN] Maximum unique tasks (50) reached; the update was dropped",
                  ],
                },
              }
            : {}),
        });

        return;
      }

      calls.push({ channel: "slack", method, thread, body });
      reply(200, { ok: true, channel: body.channel, ts });

      return;
    }

    const github = path.match(
      /^\/github\/repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)\/(comments|reviews)$/,
    );

    if (github && req.method === "POST") {
      const [, owner, repo, number, kind] = github;
      const method =
        kind === "reviews" ? "pulls.createReview" : "issues.createComment";

      calls.push({
        channel: "github",
        method,
        thread: `${owner}/${repo}#${number}`,
        body,
      });
      reply(201, { id: counter, body: body.body });

      return;
    }

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

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    posts: (filter = {}) => {
      return calls.filter((call) => {
        return (
          (!filter.channel || call.channel === filter.channel) &&
          (!filter.method || call.method === filter.method) &&
          (!filter.thread || call.thread === filter.thread)
        );
      });
    },
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
};
