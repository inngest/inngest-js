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
  defineEventHandler,
  type EventHandlerRequest,
  type EventHandlerResponse,
  getHeader,
  getQuery,
  getResponseHeaders,
  getResponseStatus,
  type H3Event,
  readBody,
  readRawBody,
  send,
  setHeaders,
} from "h3";
import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
  type SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { processEnv } from "./helpers/env.ts";
import { stringify } from "./helpers/strings.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "h3";

const commHandler = (
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    syncOptions,
    handler: (event: H3Event<EventHandlerRequest>) => {
      return {
        body: () => readBody(event),
        textBody: async () => {
          const method = event.method;
          const body =
            method === "POST" ||
            method === "PUT" ||
            method === "PATCH" ||
            method === "DELETE"
              ? ((await readRawBody(event, "utf-8")) ?? "")
              : "";

          return body;
        },
        headers: (key) => getHeader(event, key),
        method: () => event.method,
        url: () => {
          let scheme = "https";
          if ((processEnv("NODE_ENV") ?? "dev").startsWith("dev")) {
            scheme = "http";
          }

          return new URL(
            String(event.path),
            `${scheme}://${String(getHeader(event, "host"))}`,
          );
        },
        queryString: (key) => {
          const param = getQuery(event)[key];
          if (param) {
            return String(param);
          }

          return;
        },
        transformResponse: (actionRes): EventHandlerResponse => {
          const { res } = event.node;
          res.statusCode = actionRes.status;
          setHeaders(event, actionRes.headers);
          return send(event, actionRes.body);
        },
        experimentalTransformSyncResponse: async (data) => {
          const headers = Object.entries(
            getResponseHeaders(event) ?? {},
          ).reduce(
            (acc, [key, value]) => {
              acc[key] = Array.isArray(value) ? value.join(",") : `${value}`;

              return acc;
            },
            {} as Record<string, string>,
          );

          return {
            body: typeof data === "string" ? data : stringify(data),
            headers,
            status: getResponseStatus(event) ?? 200,
          };
        },
      };
    },
  });

  return handler;
};

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
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((event: H3Event<EventHandlerRequest>) => Promise<void>) => {
  return commHandler(options).createHandler();
};

/**
 * In h3, create a function that can define an event handler with Inngest steps
 * enabled, allowing you to use steps seamlessly within that API.
 *
 * @example
 * ```ts
 * import { Inngest, step } from "inngest";
 * import { createExperimentalEndpointWrapper } from "inngest/h3";
 *
 * const inngestEventHandler = createExperimentalEndpointWrapper({
 *   client: new Inngest({ id: "h3-sync-example" }),
 * });
 *
 *
 * export default inngestEventHandler(async (event) => {
 *   const foo = await step.run("example/step", async () => {
 *     return "Hello from step!";
 *   });
 *
 *   return `
 *       <meta charset="utf-8">
 *       <h1>This endpoint worked!</h1>
 *       <p>The step's result was: ${foo}</p>
 *     `;
 * });
 * ```
 */
export const createExperimentalEndpointWrapper = (
  options: SyncHandlerOptions,
) => {
  const inngestWrapper = commHandler(options, options).createSyncHandler();

  const h3Handler: typeof inngestWrapper = (userlandHandler) => {
    return defineEventHandler(inngestWrapper(userlandHandler));
  };

  return h3Handler;
};
