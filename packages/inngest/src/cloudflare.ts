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
 * @example Cloudflare Workers
 * ```ts
 * import { serve } from "inngest/cloudflare";
 * import { inngest } from "../../inngest/client";
 * import fnA from "../../inngest/fnA"; // Your own function
 *
 * export default {
 *   fetch: serve({
 *     client: inngest,
 *     functions: [fnA],
 *   }),
 * };
 * ```
 *
 * @module
 */

import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { Either } from "./helpers/types.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "cloudflare-pages";

/**
 * Expected arguments for a Cloudflare Pages Function.
 */
export type PagesHandlerArgs = [
  { request: Request; env: Record<string, string | undefined> },
];

/**
 * Expected arguments for a Cloudflare Worker.
 */
export type WorkersHandlerArgs = [Request, Record<string, string | undefined>];

/**
 * Support both Cloudflare Pages Functions and Cloudflare Workers by lightly
 * asserting the shape of the input arguments at runtime.
 */
const deriveHandlerArgs = (
  args: Either<PagesHandlerArgs, WorkersHandlerArgs>,
): { req: Request; env: Record<string, string | undefined> } => {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error("No arguments passed to serve handler");
  }

  if (typeof args[0] === "object" && "request" in args[0] && "env" in args[0]) {
    return {
      req: args[0].request,
      env: args[0].env,
    };
  }

  if (args.length > 1 && typeof args[1] === "object") {
    return {
      req: args[0],
      env: args[1],
    };
  }

  throw new Error(
    "Could not derive handler arguments from input; are you sure you're using serve() correctly?",
  );
};

/**
 * In Cloudflare, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example Cloudflare Pages
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
 * @example Cloudflare Workers
 * ```ts
 * import { serve } from "inngest/cloudflare";
 * import { inngest } from "../../inngest/client";
 * import fnA from "../../inngest/fnA"; // Your own function
 *
 * export default {
 *   fetch: serve({
 *     client: inngest,
 *     functions: [fnA],
 *   }),
 * };
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((
  ...args: Either<PagesHandlerArgs, WorkersHandlerArgs>
) => Promise<Response>) => {
  const handler = new InngestCommHandler({
    frameworkName,

    /**
     * Assume that we want to override the `fetch` implementation with the one
     * globally available in the Cloudflare env. Specifying it here will
     * ensure we avoid trying to load a Node-compatible version later.
     */
    fetch: fetch.bind(globalThis),
    ...options,
    handler: (...args: Either<PagesHandlerArgs, WorkersHandlerArgs>) => {
      const { req, env } = deriveHandlerArgs(args);

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
        transformStreamingResponse: ({ body, status, headers }) => {
          return new Response(body, {
            status,
            headers,
          });
        },
        badNameApi: null,
      };
    },
  });

  /**
   * Assign a non-variadic length to the handler to ensure early runtime guards
   * aren't triggered when assessing whether exported functions are valid within
   * the framework.
   */
  const requestHandler = Object.defineProperties(handler.createHandler(), {
    length: { value: 2 },
  });

  return requestHandler;
};
