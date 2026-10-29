/**
 * @module
 * EXPERIMENTAL: a fake remote MCP server for tests of `tool.mcp()`. The same
 * server runs two ways: `fakeMcpServer()` listens on localhost (for e2e runs
 * and Connect workers), and `fakeMcpFetch()` is an in-memory `fetch` you pass
 * as `tool.mcp({ fetch })`, so a unit test needs no socket. Both keep every
 * request in `calls`, with the headers the server received, so a test proves
 * the bearer arrived and that it appears nowhere else.
 */
import { createServer } from "node:http";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";

/**
 * A tool of the fake server.
 */
export interface FakeMcpTool {
  description?: string;

  /**
   * JSON Schema of the arguments. Default: any object.
   */
  inputSchema?: { type: "object"; [key: string]: unknown };

  /**
   * What the server says about the tool. `readOnlyHint` and `idempotentHint`
   * let `tool.mcp()` retry a call whose outcome is unknown.
   */
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
  };

  /**
   * Runs the call. A string becomes a text block; any other value becomes
   * `structuredContent` (and its JSON as text). Throwing gives an `isError`
   * result.
   */
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface FakeMcpOptions {
  tools: Record<string, FakeMcpTool>;

  /**
   * The bearer token the server wants. Without it, any request is accepted.
   */
  token?: string;

  /**
   * Answer `tools/call` as an event stream instead of JSON.
   */
  stream?: boolean;
}

/**
 * One request the fake server received.
 */
export interface FakeMcpCall {
  /**
   * The JSON-RPC method, such as `tools/call`.
   */
  method: string;

  /**
   * The tool, for `tools/call`.
   */
  tool?: string;

  /**
   * The arguments, for `tools/call`.
   */
  args?: unknown;

  /**
   * The `_meta` of a `tools/call`.
   */
  meta?: unknown;

  /**
   * The request's headers, lower-cased.
   */
  headers: Record<string, string>;

  /**
   * The raw request body.
   */
  body: string;
}

export interface FakeMcpServer {
  /**
   * The endpoint to give `tool.mcp({ url })`.
   */
  url: string;

  /**
   * Every request, in order.
   */
  calls: FakeMcpCall[];

  /**
   * Answer the next `n` requests with HTTP `status`.
   */
  failNext: (n: number, status: number) => void;

  /**
   * Run the next `n` `tools/call` requests, then drop the connection before
   * answering: the server acted and the client never hears.
   */
  dropNext: (n: number) => void;

  /**
   * Wait `ms` before every answer.
   */
  latency: (ms: number) => void;

  /**
   * Forget every session, so the next request with a session id gets 404.
   */
  expireSessions: () => void;

  /**
   * Answer every request with 401 and an OAuth challenge.
   */
  oauthOnly: () => void;

  /**
   * Stops the server. Does nothing for the in-memory fetch.
   */
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export interface FakeMcp extends FakeMcpServer {
  /**
   * An in-memory `fetch` served by this fake, for `tool.mcp({ fetch })`.
   * Give `tool.mcp` the `url` too.
   */
  fetch: typeof fetch;
}

class Dropped extends Error {}

const headersOf = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};

  headers.forEach((value, name) => {
    out[name] = value;
  });

  return out;
};

const json = (status: number, body: unknown, headers: HeadersInit = {}) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
};

const createFake = (options: FakeMcpOptions) => {
  const calls: FakeMcpCall[] = [];
  let sessions = new Set<string>();
  let failures: number[] = [];
  let drops = 0;
  let delay = 0;
  let oauth = false;
  let nextSession = 1;

  const result = (id: unknown, body: unknown) => {
    return { jsonrpc: "2.0", id, result: body };
  };

  const handle = async (request: Request): Promise<Response> => {
    const body = await request.text();
    const headers = headersOf(request.headers);
    const message = JSON.parse(body || "{}") as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = message.method ?? "";
    const params = message.params ?? {};

    calls.push({
      method,
      ...(method === "tools/call" && {
        tool: params.name as string,
        args: params.arguments,
        meta: params._meta,
      }),
      headers,
      body,
    });

    if (delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }

    if (oauth) {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://fake.test/.well-known/oauth-protected-resource"',
        },
      });
    }

    const failure = failures.shift();

    if (failure !== undefined) {
      return new Response("", { status: failure });
    }

    if (
      options.token !== undefined &&
      headers.authorization !== `Bearer ${options.token}`
    ) {
      return new Response("", { status: 401 });
    }

    if (method === "initialize") {
      const id = `session-${nextSession++}`;

      sessions.add(id);

      return json(
        200,
        result(message.id, {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1" },
        }),
        { "mcp-session-id": id },
      );
    }

    const session = headers["mcp-session-id"];

    if (session !== undefined && !sessions.has(session)) {
      return new Response("", { status: 404 });
    }

    if (method.startsWith("notifications/")) {
      return new Response("", { status: 202 });
    }

    if (method === "tools/list") {
      return json(
        200,
        result(message.id, {
          tools: Object.entries(options.tools).map(([name, definition]) => {
            return {
              name,
              description: definition.description,
              inputSchema: definition.inputSchema ?? { type: "object" },
              annotations: definition.annotations,
            };
          }),
        }),
      );
    }

    if (method === "tools/call") {
      const definition = Object.hasOwn(options.tools, params.name as string)
        ? options.tools[params.name as string]
        : undefined;

      if (!definition) {
        return json(200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `Unknown tool: ${params.name}` },
        });
      }

      let answer: Record<string, unknown>;

      try {
        const value = await definition.run(
          (params.arguments ?? {}) as Record<string, unknown>,
        );

        answer =
          typeof value === "string"
            ? { content: [{ type: "text", text: value }] }
            : {
                content: [{ type: "text", text: JSON.stringify(value) }],
                structuredContent: value,
              };
      } catch (error) {
        answer = {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }

      if (drops > 0) {
        drops -= 1;

        throw new Dropped();
      }

      const reply = result(message.id, answer);

      return options.stream
        ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        : json(200, reply);
    }

    return json(200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  };

  const control = {
    calls,
    failNext: (n: number, status: number) => {
      failures = [...failures, ...Array(n).fill(status)];
    },
    dropNext: (n: number) => {
      drops += n;
    },
    latency: (ms: number) => {
      delay = ms;
    },
    expireSessions: () => {
      sessions = new Set();
    },
    oauthOnly: () => {
      oauth = true;
    },
  };

  return { handle, control };
};

/**
 * A fake MCP server that listens on localhost.
 */
export const fakeMcpServer = async (
  options: FakeMcpOptions,
): Promise<FakeMcpServer> => {
  const { handle, control } = createFake(options);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    try {
      const response = await handle(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
        }),
      );

      res.writeHead(response.status, headersOf(response.headers));
      res.end(await response.text());
    } catch (error) {
      if (error instanceof Dropped) {
        req.socket.destroy();

        return;
      }

      throw error;
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("The fake MCP server has no port");
  }

  const url = `http://127.0.0.1:${address.port}/mcp`;
  const close = () => {
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  };

  return {
    ...control,
    url,
    close,
    [asyncDispose]: close,
  };
};

/**
 * A fake MCP server as an in-memory `fetch`, with the same controls.
 */
export const fakeMcpFetch = (options: FakeMcpOptions): FakeMcp => {
  const { handle, control } = createFake(options);
  const fetcher: typeof fetch = async (input, init) => {
    try {
      return await handle(new Request(input, init));
    } catch (error) {
      if (error instanceof Dropped) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      }

      throw error;
    }
  };
  const close = async () => {};

  return {
    ...control,
    url: "https://mcp.fake.test/mcp",
    fetch: fetcher,
    close,
    [asyncDispose]: close,
  };
};
