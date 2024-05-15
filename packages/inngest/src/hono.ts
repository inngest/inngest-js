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
        url: () => {
          // If this is an absolute URL, use it right now.
          if (URL.canParse(c.req.url)) {
            return new URL(c.req.url);
          }

          // We now know that `c.req.url` is a relative URL, so let's try
          // to build a base URL to pair it with.
          const host = options.serveHost || c.req.header("host");
          if (!host) {
            throw new Error(
              "No host header found in request and no `serveHost` given either."
            );
          }

          let baseUrl = host;
          // Only set the scheme if we don't already have one, as a user may
          // have specified the protocol in `serveHost` as a way to force it
          // in their environment, e.g. for testing.
          if (!baseUrl.includes("://")) {
            let scheme: "http" | "https" = "https";
            try {
              // If we're in dev, assume `http` instead. Not that we directly
              // access the environment instead of using any helpers here to
              // ensure compatibility with tools with Webpack which will replace
              // this with a literal.
              // eslint-disable-next-line @inngest/internal/process-warn
              if (process.env.NODE_ENV !== "production") {
                scheme = "http";
              }
            } catch (err) {
              // no-op
            }

            baseUrl = `${scheme}://${baseUrl}`;
          }

          return new URL(c.req.url, baseUrl);
        },
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
