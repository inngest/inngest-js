/**
 * An adapter for Koa to serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * const handler = serve({
 *   client: inngest,
 *   functions
 * });
 *
 * app.use((ctx) => {
 *   if (ctx.request.path === "/api/inngest") {
 *     return handler(ctx);
 *   }
 * });
 * ```
 *
 * @module
 */

import type Koa from "koa";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "koa";

/**
 * Using Koa, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * const handler = serve({
 *   client: inngest,
 *   functions
 * });
 *
 * app.use((ctx) => {
 *   if (ctx.request.path === "/api/inngest") {
 *     return handler(ctx);
 *   }
 * });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ((
  ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext, unknown>,
) => Promise<void>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      ctx: Koa.ParameterizedContext<
        Koa.DefaultState,
        Koa.DefaultContext,
        unknown
      >,
    ) => {
      return {
        method: () => ctx.method,
        body: () =>
          (ctx.request as unknown as { body: Record<string, unknown> }).body,
        headers: (key) => {
          const header = ctx.headers[key];

          if (Array.isArray(header)) {
            return header[0];
          }

          return header;
        },
        queryString: (key) => {
          const qs = ctx.query[key];

          if (Array.isArray(qs)) {
            return qs[0];
          }

          return qs;
        },
        url: () => {
          const hostname = ctx.host;
          const protocol = hostname?.includes("://")
            ? ""
            : `${ctx.protocol}://`;
          const url = new URL(ctx.originalUrl, `${protocol}${hostname || ""}`);

          return url;
        },
        transformResponse: ({ body, headers, status }) => {
          for (const [name, value] of Object.entries(headers)) {
            ctx.set(name, value);
          }

          ctx.status = status;
          ctx.body = body;
        },
        badNameApi: null,
      };
    },
  });

  return handler.createHandler();
};
