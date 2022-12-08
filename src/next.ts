import type { NextApiRequest, NextApiResponse } from "next";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    "nextjs",
    nameOrInngest,
    fns,
    opts,
    (req: NextApiRequest, _res: NextApiResponse) => {
      const scheme = process.env.NODE_ENV === "development" ? "http" : "https";
      const url = new URL(
        req.url as string,
        `${scheme}://${req.headers.host || ""}`
      );
      const isProduction =
        process.env.VERCEL_ENV === "production" ||
        process.env.CONTEXT === "production" ||
        process.env.ENVIRONMENT === "production";

      return {
        register: () => {
          if (req.method === "PUT") {
            return {
              env: process.env,
              url,
              isProduction,
            };
          }
        },
        run: () => {
          if (req.method === "POST") {
            return {
              data: req.body as Record<string, any>,
              fnId: req.query[queryKeys.FnId] as string,
              env: process.env,
              isProduction,
              url,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              env: process.env,
              isIntrospection: Object.hasOwnProperty.call(
                req.query,
                queryKeys.Introspect
              ),
              url,
              isProduction,
            };
          }
        },
      };
    },
    (actionRes, req, res) => {
      for (const [key, value] of Object.entries(actionRes.headers)) {
        res.setHeader(key, value);
      }

      res.status(actionRes.status).send(actionRes.body);
    }
  );

  return handler.createHandler();
};
