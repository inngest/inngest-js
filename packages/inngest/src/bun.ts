/**
 * An adapter for Bun to serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/bun";
 * import { functions, inngest } from "./inngest";
 *
 * Bun.serve({
 *   port: 3000,
 *   fetch(request: Request) {
 *     const url = new URL(request.url);
 *
 *     if (url.pathname === "/api/inngest") {
 *       return serve({ client: inngest, functions })(request);
 *     }
 *
 *     return new Response("Not found", { status: 404 });
 *   },
 * });
 * ```
 *
 * @module
 */

import {
  type InternalServeHandlerOptions,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.js";
import { serve as serveEdge } from "./edge.js";
import { type SupportedFrameworkName } from "./types.js";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "bun";

/**
 * Using `Bun.serve()`, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/bun";
 * import { functions, inngest } from "./inngest";
 *
 * Bun.serve({
 *   port: 3000,
 *   fetch(request: Request) {
 *     const url = new URL(request.url);
 *
 *     if (url.pathname === "/api/inngest") {
 *       return serve({ client: inngest, functions })(request);
 *     }
 *
 *     return new Response("Not found", { status: 404 });
 *   },
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions
): ((req: Request) => Promise<Response>) => {
  const optsOverrides: InternalServeHandlerOptions = {
    ...options,
    frameworkName,
  };

  return serveEdge(optsOverrides);
};
