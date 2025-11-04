/**
 * An adapter for Deno's Fresh to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "https://esm.sh/inngest/deno/fresh";
 * import { inngest } from "./src/inngest/client.ts";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * export const handler = serve({
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
} from "../components/InngestCommHandler.ts";
import type { SupportedFrameworkName } from "../types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "deno/fresh";

/**
 * With Deno's Fresh framework, serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "https://esm.sh/inngest/deno/fresh";
 * import { inngest } from "./src/inngest/client.ts";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * export const handler = serve({
 *   client: inngest,
 *   functions: [fnA],
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((req: Request) => Promise<Response>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (req: Request, env: Record<string, string>) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        env: () => env,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
        transformSyncResponse: null,
      };
    },
  });

  const fn = handler.createHandler();

  return function handleRequest(req: Request, ...other) {
    return fn(req, Deno.env.toObject(), ...other);
  };
};

declare const Deno: { env: { toObject: () => { [index: string]: string } } };
