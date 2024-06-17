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
 * export default serve({
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
import { type Either } from "./helpers/types";
import { type SupportedFrameworkName } from "./types";

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
  args: Either<PagesHandlerArgs, WorkersHandlerArgs>
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
    "Could not derive handler arguments from input; are you sure you're using serve() correctly?"
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
 * export default serve({
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
      };
    },
  });

  const requestHandler = handler.createHandler();
  type RequestHandler = typeof requestHandler;

  /**
   * When returning the handler, we haven't yet seen the input arguments for a
   * request, so we can't yet know if it's a Cloudflare Pages Function or a
   * Cloudflare Worker. We'll need to assert the shape of the input arguments
   * at runtime.
   *
   * This means that we cover all bases needed for export when returning the
   * handler, ensuring both `export const onRequest = serve(...)` and `export
   * default serve(...)` are supported.
   */
  return Object.defineProperties(requestHandler, {
    fetch: { value: requestHandler },
  }) as RequestHandler & {
    fetch: RequestHandler;
  };
};
