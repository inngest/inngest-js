import type { NextApiRequest, NextApiResponse } from "next";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { processEnv } from "./helpers/env";

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
      const scheme =
        processEnv("NODE_ENV") === "development" ? "http" : "https";
      const url = new URL(
        req.url as string,
        `${scheme}://${req.headers.host || ""}`
      );

      return {
        url,
        register: () => {
          if (req.method === "PUT") {
            return {
              deployId: req.query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        run: () => {
          if (req.method === "POST") {
            return {
              data: req.body as Record<string, unknown>,
              fnId: req.query[queryKeys.FnId] as string,
              stepId: req.query[queryKeys.StepId] as string,
              signature: req.headers[headerKeys.Signature] as string,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: Object.hasOwnProperty.call(
                req.query,
                queryKeys.Introspect
              ),
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
