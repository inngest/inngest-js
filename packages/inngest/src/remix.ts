import { z } from "zod";
import {
  InngestCommHandler,
  type ActionResponse,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type Env } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "remix";

const createNewResponse = ({
  body,
  status,
  headers,
}: ActionResponse<string | ReadableStream>): Response => {
  /**
   * If `Response` isn't included in this environment, it's probably a Node
   * env that isn't already polyfilling. In this case, we can polyfill it
   * here to be safe.
   */
  let Res: typeof Response;

  if (typeof Response === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires
    Res = require("cross-fetch").Response;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
export const serve = (options: ServeHandlerOptions) => {
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
