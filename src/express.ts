import type { Request, Response } from "express";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "express",
    nameOrInngest,
    fns,
    opts,
    (req: Request, _res: Response) => {
      const hostname = req.get("host") || req.headers["host"];
      const protocol = hostname?.includes("://") ? "" : `${req.protocol}://`;
      const url = new URL(req.originalUrl, `${protocol}${hostname || ""}`);
      const env = allProcessEnv();
      const isProduction =
        env.ENVIRONMENT === "production" || env.NODE_ENV === "production";

      return {
        run: () => {
          if (req.method === "POST") {
            return {
              fnId: req.query[queryKeys.FnId] as string,
              stepId: req.query[queryKeys.StepId] as string,
              data: req.body as Record<string, any>,
              env,
              isProduction,
              url,
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              env,
              url,
              isProduction,
              deployId: req.query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              env,
              url,
              isIntrospection: Object.hasOwnProperty.call(
                req.query,
                queryKeys.Introspect
              ),
              isProduction,
            };
          }
        },
      };
    },
    (actionRes, _req, res) => {
      for (const [name, value] of Object.entries(actionRes.headers)) {
        res.setHeader(name, value);
      }

      return res.status(actionRes.status).send(actionRes.body);
    }
  );

  return handler.createHandler();
};
