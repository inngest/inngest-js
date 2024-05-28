/**
 * An adapter for Cloudflare Workers (and Workers on Pages) to serve and
 * register any declared functions with Inngest, making them available to be
 * triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/cloudflare";
 * import { inngest } from "../../inngest/client";
 * import fnA from "../../inngest/fnA"; // Your own function
 *
 * export const onRequest = serve({
 *   client: inngest,
 *   functions: [fnA],
 * });
 * ```
 *
 * @module
 */

import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type SupportedFrameworkName } from "./types";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "cloudflare-pages";

/**
 * In Cloudflare, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/cloudflare";
 * import { inngest } from "../../inngest/client";
 * import fnA from "../../inngest/fnA"; // Your own function
 *
 * export const onRequest = serve({
 *   client: inngest,
 *   functions: [fnA],
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions
): ((ctx: {
  request: Request;
  env: Record<string, string | undefined>;
}) => Promise<Response>) => {
  const handler = new InngestCommHandler({
    frameworkName,

    /**
     * Assume that we want to override the `fetch` implementation with the one
     * globally available in the Cloudflare env. Specifying it here will
     * ensure we avoid trying to load a Node-compatible version later.
     */
    fetch: fetch.bind(globalThis),
    ...options,
    handler: ({
      request: req,
      env,
    }: {
      request: Request;
      env: Record<string, string | undefined>;
    }) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        env: () => env,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, {
            status,
            headers,
          });
        },
      };
    },
  });

  return handler.createHandler();
};
