import http from "node:http";
import type { TLSSocket } from "node:tls";
import { URL } from "node:url";
import { createWebApiCommHandler } from "./components/createWebApiCommHandler.ts";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
  type SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { handleDurableEndpointProxyRequest } from "./components/InngestDurableEndpointProxy.ts";
import { InngestEndpointAdapter } from "./components/InngestEndpointAdapter.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nodejs";

/**
 * Read the incoming message body as text.
 *
 * Collects Buffer chunks and decodes once with `Buffer.concat` so multi-byte
 * UTF-8 characters aren't corrupted when split across chunk boundaries.
 * Reads via `req.on('data'|'end')` so body-replay wrappers — notably
 * `@vercel/node`'s `restoreBody()`, which patches only those two events —
 * deliver the replayed bytes; async-iterator and `readable`-event readers
 * see an empty body under that wrapper.
 */
export async function readRequestBody(
  req: http.IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getURL(req: http.IncomingMessage, hostnameOption?: string): URL {
  const protocol =
    (req.headers["x-forwarded-proto"] as string) ||
    ((req.socket as TLSSocket)?.encrypted ? "https" : "http");
  const origin = hostnameOption || `${protocol}://${req.headers.host}`;
  return new URL(req.url || "", origin);
}

const commHandler = (options: ServeHandlerOptions | SyncHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => {
      return {
        body: () => readRequestBody(req),
        headers: (key) => {
          return req.headers[key] && Array.isArray(req.headers[key])
            ? req.headers[key][0]
            : req.headers[key];
        },
        method: () => {
          if (!req.method) {
            throw new Error(
              "Request method not defined. Potential use outside of context of Server.",
            );
          }
          return req.method;
        },
        url: () => getURL(req, options.serveOrigin),
        transformResponse: ({ body, status, headers }) => {
          res.writeHead(status, headers);
          res.end(body);
        },

        transformStreamingResponse: async ({ body, headers, status }) => {
          res.writeHead(status, headers);

          const reader = body.getReader();
          try {
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (!done) {
                res.write(result.value);
              }
            }
            res.end();
          } catch (error) {
            if (error instanceof Error) {
              res.destroy(error);
            } else {
              res.destroy(new Error(String(error)));
            }
          }
        },
      };
    },
  });

  return handler;
};

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @example Serve Inngest functions on all paths
 * ```ts
 * import { serve } from "inngest/node";
 * import { inngest } from "./src/inngest/client";
 * import myFn from "./src/inngest/myFn"; // Your own function
 *
 * const server = http.createServer(serve({
 *   client: inngest, functions: [myFn]
 * }));
 * server.listen(3000);
 * ```
 *
 * @example Serve Inngest on a specific path
 * ```ts
 * import { serve } from "inngest/node";
 * import { inngest } from "./src/inngest/client";
 * import myFn from "./src/inngest/myFn"; // Your own function
 *
 * const server = http.createServer((req, res) => {
 *   if (req.url.start === '/api/inngest') {
 *     return serve({
 *       client: inngest, functions: [myFn]
 *     })(req, res);
 *   }
 *   // ...
 * });
 * server.listen(3000);
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (options: ServeHandlerOptions): http.RequestListener => {
  return commHandler(options).createHandler() as http.RequestListener;
};

/**
 * EXPERIMENTAL - Create an http server to serve Inngest functions.
 *
 * @example
 * ```ts
 * import { createServer } from "inngest/node";
 * import { inngest } from "./src/inngest/client";
 * import myFn from "./src/inngest/myFn"; // Your own function
 *
 * const server = createServer({
 *   client: inngest, functions: [myFn]
 * });
 * server.listen(3000);
 * ```
 *
 * @public
 */
export const createServer = (options: ServeHandlerOptions) => {
  const server = http.createServer((req, res) => {
    const url = getURL(req, options.serveOrigin);
    const pathname = options.servePath || "/api/inngest";
    if (url.pathname === pathname) {
      return serve(options)(req, res);
    }
    res.writeHead(404);
    res.end();
  });
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
};

export type EndpointHandler = (req: Request) => Promise<Response>;

/**
 * Comm handler for durable endpoints. Uses Web API Request/Response since
 * that's the interface users write against, regardless of the underlying
 * runtime.
 */
function endpointCommHandler(
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
): InngestCommHandler {
  return createWebApiCommHandler(frameworkName, options, syncOptions);
}

/**
 * Creates a durable endpoint proxy handler for Node.js environments.
 */
function createDurableEndpointProxyHandler(
  options: InngestEndpointAdapter.ProxyHandlerOptions,
): http.RequestListener {
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = getURL(req);

    const result = await handleDurableEndpointProxyRequest(
      options.client as Inngest.Any,
      {
        runId: url.searchParams.get("runId"),
        token: url.searchParams.get("token"),
        method: req.method || "GET",
      },
    );

    res.writeHead(result.status, result.headers);
    res.end(result.body);
  };
}

/**
 * In a Node.js environment, create a function that can wrap any endpoint to be
 * able to use steps seamlessly within that API.
 */
export const endpointAdapter = InngestEndpointAdapter.create((options) => {
  return endpointCommHandler(options, options).createSyncHandler();
}, createDurableEndpointProxyHandler);

/**
 * Bridge a Web API endpoint handler to a Node.js `http.RequestListener`.
 *
 * Converts an incoming `http.IncomingMessage` into a Web API `Request`,
 * invokes the handler, then streams the resulting `Response` back through
 * the Node.js `http.ServerResponse`.
 *
 * Important: uses `value != null` (not `value`) when forwarding headers so
 * that empty-string headers (like `X-Inngest-Signature: ""` in dev mode)
 * are preserved. Dropping them breaks `isInngestReq()` detection.
 */
export function serveEndpoint(handler: EndpointHandler): http.RequestListener {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readRequestBody(req);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value != null) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headers.append(key, v);
          }
        } else if (typeof value === "string") {
          headers.set(key, value);
        }
      }
    }

    const url = getURL(req);
    const webRequest = new Request(url.href, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
    });

    try {
      const webResponse = await handler(webRequest);

      const resHeaders: Record<string, string> = {};
      webResponse.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
      res.writeHead(webResponse.status, resHeaders);

      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end(String(err));
    }
  };
}

/**
 * Create an HTTP server that serves a durable endpoint handler.
 *
 * This bridges the Web API `Request`/`Response` interface that Durable
 * Endpoints use with Node.js's `http.Server`.
 */
export function createEndpointServer(handler: EndpointHandler): http.Server {
  const listener = serveEndpoint(handler);
  const server = http.createServer(listener);
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
}
