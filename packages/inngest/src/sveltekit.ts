/**
 * An adapter for SvelteKit to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * // app/routes/api.inngest.ts
 * // (for Remix 1, use app/routes/api/inngest.ts)
 * import { serve } from "inngest/remix";
 * import { inngest } from "~/inngest/client";
 * import fnA from "~/inngest/fnA";
 *
 * const handler = serve({
 *   client: inngest,
 *   functions: [fnA],
 * });
 *
 * export { handler as action, handler as loader };
 * ```
 *
 * @module
 */

import type { RequestEvent } from "@sveltejs/kit";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { processEnv } from "./helpers/env.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "sveltekit";

/**
 * Using SvelteKit, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * // app/routes/api.inngest.ts
 * // (for Remix 1, use app/routes/api/inngest.ts)
 * import { serve } from "inngest/remix";
 * import { inngest } from "~/inngest/client";
 * import fnA from "~/inngest/fnA";
 *
 * const handler = serve({
 *   client: inngest,
 *   functions: [fnA],
 * });
 *
 * export { handler as action, handler as loader };
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((event: RequestEvent) => Promise<Response>) & {
  GET: (event: RequestEvent) => Promise<Response>;
  POST: (event: RequestEvent) => Promise<Response>;
  PUT: (event: RequestEvent) => Promise<Response>;
} => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      reqMethod: "GET" | "POST" | "PUT" | undefined,
      event: RequestEvent,
    ) => {
      return {
        method: () => reqMethod || event.request.method || "",
        body: () => event.request.json(),
        headers: (key) => event.request.headers.get(key),
        url: () => {
          const protocol =
            processEnv("NODE_ENV") === "development" ? "http" : "https";

          return new URL(
            event.request.url,
            `${protocol}://${
              event.request.headers.get("host") || options.serveOrigin || ""
            }`,
          );
        },
        transformResponse: ({ body, headers, status }) => {
          /**
           * If `Response` isn't included in this environment, it's probably a
           * Node env that isn't already polyfilling. In this case, we can
           * polyfill it here to be safe.
           */
          let Res: typeof Response;

          if (typeof Response === "undefined") {
            Res = require("cross-fetch").Response;
          } else {
            Res = Response;
          }

          return new Res(body, { status, headers });
        },
      };
    },
  });

  const baseFn = handler.createHandler();

  const fn = baseFn.bind(null, undefined);
  type Fn = typeof fn;

  const handlerFn = Object.defineProperties(fn, {
    GET: { value: baseFn.bind(null, "GET") },
    POST: { value: baseFn.bind(null, "POST") },
    PUT: { value: baseFn.bind(null, "PUT") },
  }) as Fn & {
    GET: Fn;
    POST: Fn;
    PUT: Fn;
  };

  return handlerFn;
};
