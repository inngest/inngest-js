import http from "node:http";
import { type TLSSocket } from "node:tls";
import { URL } from "node:url";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.js";
import { type SupportedFrameworkName } from "./types.js";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nodejs";

/**
 * Parse the incoming message request as a JSON body
 */
async function parseRequestBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const json = JSON.parse(body) as unknown;
        resolve(json);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function getURL(req: http.IncomingMessage, hostnameOption?: string): URL {
  const protocol =
    (req.headers["x-forwarded-proto"] as string) ||
    ((req.socket as TLSSocket)?.encrypted ? "https" : "http");
  const origin = hostnameOption || `${protocol}://${req.headers.host}`;
  return new URL(req.url || "", origin);
}

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
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => {
      return {
        body: async () => parseRequestBody(req),
        headers: (key) => {
          return req.headers[key] && Array.isArray(req.headers[key])
            ? req.headers[key][0]
            : req.headers[key];
        },
        method: () => {
          if (!req.method) {
            throw new Error(
              "Request method not defined. Potential use outside of context of Server."
            );
          }
          return req.method;
        },
        url: () => getURL(req, options.serveHost),
        transformResponse: ({ body, status, headers }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
      };
    },
  });
  return handler.createHandler() as http.RequestListener;
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
    const url = getURL(req, options.serveHost);
    const pathname = options.servePath || "/api/inngest";
    if (url.pathname === pathname) {
      return serve(options)(req, res);
    }
    res.writeHead(404);
    res.end();
  });
  server.on("clientError", (err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
};
