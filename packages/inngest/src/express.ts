import { type VercelRequest, type VercelResponse } from "@vercel/node";
import { type Request, type Response } from "express";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { type Either } from "./helpers/types";
import { type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "express";

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
      req: Either<Request, VercelRequest>,
      _res: Either<Response, VercelResponse>
    ) => {
      // `req.hostname` can filter out port numbers; beware!
      const hostname = req.headers["host"] || opts?.serveHost;

      const protocol = hostname?.includes("://")
        ? ""
        : `${req.protocol || "https"}://`;

      const url = new URL(
        req.originalUrl || req.url || "",
        `${protocol}${hostname || ""}`
      );

      return {
        url,
        run: () => {
          if (req.method === "POST") {
            return {
              fnId: req.query[queryKeys.FnId] as string,
              stepId: req.query[queryKeys.StepId] as string,
              data: req.body as Record<string, unknown>,
              signature: req.headers[headerKeys.Signature] as string,
            };
          }
        },
        register: () => {
          if (req.method === "PUT") {
            return {
              deployId: req.query[queryKeys.DeployId]?.toString(),
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
    (actionRes, _req, res) => {
      for (const [name, value] of Object.entries(actionRes.headers)) {
        res.setHeader(name, value);
      }

      return res.status(actionRes.status).send(actionRes.body);
    }
  );

  return handler.createHandler();
};
