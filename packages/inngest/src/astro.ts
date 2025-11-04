/**
 * An adapter for Astro to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * export const { GET, POST, PUT } = serve({
 *   client: inngest,
 *   functions: [fn1, fn2],
 * });
 * ```
 *
 * @module
 */

import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "astro";

/**
 * In Astro, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * @example
 * ```ts
 * export const { GET, POST, PUT } = serve({
 *   client: inngest,
 *   functions: [fn1, fn2],
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((ctx: { request: Request }) => Promise<Response>) & {
  GET: (ctx: { request: Request }) => Promise<Response>;
  POST: (ctx: { request: Request }) => Promise<Response>;
  PUT: (ctx: { request: Request }) => Promise<Response>;
} => {
  const commHandler = new InngestCommHandler({
    frameworkName,
    fetch: fetch.bind(globalThis),
    ...options,
    handler: ({ request: req }: { request: Request }) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
        transformSyncResponse: null,
      };
    },
  });

  const requestHandler = commHandler.createHandler();
  type RequestHandler = typeof requestHandler;

  return Object.defineProperties(requestHandler, {
    GET: { value: requestHandler },
    POST: { value: requestHandler },
    PUT: { value: requestHandler },
  }) as RequestHandler & {
    GET: RequestHandler;
    POST: RequestHandler;
    PUT: RequestHandler;
  };
};
