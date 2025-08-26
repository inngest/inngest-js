/**
 * An adapter for Remix to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/remix";
 * import functions from "~/inngest";
 *
 * const handler = serve({ id: "my-remix-app", functions });
 *
 * export { handler as loader, handler as action };
 * ```
 *
 * @module
 */

import { z } from "zod/v3";
import {
  type ActionResponse,
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { Env } from "./helpers/env.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "remix";

const createNewResponse = ({
  body,
  status,
  headers,
}: ActionResponse<string | ReadableStream>): Response => {
  /**
   * If `Response` isn't included in this environment, it's probably a Node env
   * that isn't already polyfilling. In this case, we can polyfill it here to be
   * safe.
   */
  let Res: typeof Response;

  if (typeof Response === "undefined") {
    Res = require("cross-fetch").Response;
  } else {
    Res = Response;
  }

  return new Res(body, {
    status,
    headers,
  });
};

/**
 * In Remix, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * Remix requires that you export both a "loader" for serving `GET` requests,
 * and an "action" for serving other requests, therefore exporting both is
 * required.
 *
 * See {@link https://remix.run/docs/en/v1/guides/resource-routes}
 *
 * @example
 * ```ts
 * import { serve } from "inngest/remix";
 * import functions from "~/inngest";
 *
 * const handler = serve({ id: "my-remix-app", functions });
 *
 * export { handler as loader, handler as action };
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((ctx: { request: Request; context?: unknown }) => Promise<Response>) => {
  const contextSchema = z.object({
    env: z.record(z.string(), z.any()),
  });

  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: ({
      request: req,
      context,
    }: {
      request: Request;
      context?: unknown;
    }) => {
      return {
        env: () => {
          const ctxParse = contextSchema.safeParse(context);

          if (ctxParse.success && Object.keys(ctxParse.data.env).length) {
            return ctxParse.data.env as Env;
          }

          return;
        },
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: createNewResponse,
        transformStreamingResponse: createNewResponse,
      };
    },
  });

  return handler.createHandler();
};
