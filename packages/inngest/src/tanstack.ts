/**
 * An adapter for the Tanstack Start framework.
 *
 * @example
 * ```ts
 * import { createAPIFileRoute } from '@tanstack/start/api';
 * import { serve } from "inngest/tanstack";
 * import functions from "~/inngest";
 *
 * export const APIRoute = createAPIFileRoute('/api/inngest')(
 *   serve({
 *     client: inngest,
 *     functions,
 *   })
 * );
 * ```
 *
 * @module
 */

import { type createAPIFileRoute } from "@tanstack/start/api";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.js";
import { type SupportedFrameworkName } from "./types.js";

type CreateAPIRouteFn = ReturnType<typeof createAPIFileRoute>;
type CreateAPIRouteFnArgs = Parameters<CreateAPIRouteFn>;
type CreateAPIRouteMethodCallbacks = CreateAPIRouteFnArgs extends [
  infer Head,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...any[],
]
  ? Head
  : never;

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "tanstack";

/**
 * Using Tanstack Start, serve any defined functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { createAPIFileRoute } from '@tanstack/start/api';
 * import { serve } from "inngest/tanstack";
 * import functions from "~/inngest";
 *
 * export const APIRoute = createAPIFileRoute('/api/inngest')(
 *   serve({
 *     client: inngest,
 *     functions,
 *   })
 * );
 * ```
 *
 * @public
 */
export const serve = (
  options: ServeHandlerOptions
): CreateAPIRouteMethodCallbacks => {
  const handler = new InngestCommHandler({
    frameworkName,
    fetch: fetch.bind(globalThis),
    ...options,
    handler: (req: Request) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

  const requestHandler = handler.createHandler();

  // Return the structure expected by createAPIFileRoute
  return {
    GET: ({ request }: { request: Request }) => {
      return requestHandler(request);
    },
    POST: ({ request }: { request: Request }) => {
      return requestHandler(request);
    },
    PUT: ({ request }: { request: Request }) => {
      return requestHandler(request);
    },
  };
};
