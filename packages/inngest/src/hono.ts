import { type Context } from "hono";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type Env } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "hono";

/**
 * Using Hono, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * const handler = serve({
 *   client: inngest,
 *   functions
 * });
 *
 * app.use('/api/inngest',  async (c) => {
 *   return handler(c);
 * });
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    fetch: fetch.bind(globalThis),
    frameworkName,
    ...options,
    handler: (c: Context) => {
      return {
        transformResponse: ({ headers, status, body }) => {
          return c.body(body, { headers, status });
        },
        url: () => new URL(c.req.url, c.req.header("host")),
        queryString: (key) => c.req.query(key),
        headers: (key) => c.req.header(key),
        method: () => c.req.method,
        body: () => c.req.json(),
        env: () => c.env as Env,
      };
    },
  });

  return handler.createHandler();
};
