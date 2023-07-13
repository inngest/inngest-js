import type Koa from "koa";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "koa";

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    opts,
    (
      ctx: Koa.ParameterizedContext<
        Koa.DefaultState,
        Koa.DefaultContext,
        unknown
      >
    ) => {
      const hostname = ctx.host;
      const protocol = hostname?.includes("://") ? "" : `${ctx.protocol}://`;
      const url = new URL(ctx.originalUrl, `${protocol}${hostname || ""}`);

      return {
        url,
        run: () => {
          if (ctx.method === "POST") {
            return {
              fnId: ctx.query[queryKeys.FnId] as string,
              stepId: ctx.query[queryKeys.StepId] as string,
              data: (
                ctx.request as unknown as { body: Record<string, unknown> }
              ).body,
              signature: ctx.headers[headerKeys.Signature] as string,
            };
          }
        },
        register: () => {
          if (ctx.method === "PUT") {
            return {
              deployId: ctx.query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        view: () => {
          if (ctx.method === "GET") {
            return {
              isIntrospection: Object.hasOwnProperty.call(
                ctx.query,
                queryKeys.Introspect
              ),
            };
          }
        },
      };
    },
    (actionRes, ctx) => {
      for (const [name, value] of Object.entries(actionRes.headers)) {
        ctx.set(name, value);
      }
      ctx.status = actionRes.status;
      ctx.body = actionRes.body;
    }
  );

  return handler.createHandler();
};
