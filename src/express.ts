import type { Request, Response } from "express";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";

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

      const isProduction =
        process.env.ENVIRONMENT === "production" ||
        process.env.NODE_ENV === "production";

      return {
        run: () => {
          if (req.method === "POST") {
            return {
              fnId: req.query[queryKeys.FnId] as string,
              data: req.body as Record<string, any>,
              env: process.env,
              isProduction,
              url,
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              env: process.env,
              url,
              isProduction,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              env: process.env,
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
