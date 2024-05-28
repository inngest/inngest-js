/**
 * An adapter for H3 to serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { createApp, eventHandler, toNodeListener } from "h3";
 * import { serve } from "inngest/h3";
 * import { createServer } from "node:http";
 * import { inngest } from "./inngest/client";
 * import fnA from "./inngest/fnA";
 *
 * const app = createApp();
 * app.use(
 *   "/api/inngest",
 *   eventHandler(
 *     serve({
 *       client: inngest,
 *       functions: [fnA],
 *     })
 *   )
 * );
 *
 * createServer(toNodeListener(app)).listen(process.env.PORT || 3000);
 * ```
 *
 * @module
 */

import {
  getHeader,
  getQuery,
  readBody,
  send,
  setHeaders,
  type H3Event,
} from "h3";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { processEnv } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "h3";

/**
 * In h3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { createApp, eventHandler, toNodeListener } from "h3";
 * import { serve } from "inngest/h3";
 * import { createServer } from "node:http";
 * import { inngest } from "./inngest/client";
 * import fnA from "./inngest/fnA";
 *
 * const app = createApp();
 * app.use(
 *   "/api/inngest",
 *   eventHandler(
 *     serve({
 *       client: inngest,
 *       functions: [fnA],
 *     })
 *   )
 * );
 *
 * createServer(toNodeListener(app)).listen(process.env.PORT || 3000);
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (event: H3Event) => {
      return {
        body: () => readBody(event),
        headers: (key) => getHeader(event, key),
        method: () => event.method,
        url: () =>
          new URL(
            String(event.path),
            `${
              processEnv("NODE_ENV") === "development" ? "http" : "https"
            }://${String(getHeader(event, "host"))}`
          ),
        queryString: (key) => String(getQuery(event)[key]),
        transformResponse: (actionRes) => {
          const { res } = event.node;
          res.statusCode = actionRes.status;
          setHeaders(event, actionRes.headers);
          return send(event, actionRes.body);
        },
      };
    },
  });

  return handler.createHandler();
};
