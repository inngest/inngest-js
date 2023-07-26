import { type Request, type Response } from "express";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
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
    (req: Request, _res: Response) => {
      const hostname = req.get("host") || req.headers["host"];
      const protocol = hostname?.includes("://") ? "" : `${req.protocol}://`;
      const url = new URL(req.originalUrl, `${protocol}${hostname || ""}`);

      return {
        url,
        run: () => {
          if (req.method === "POST") {
            return {
              fnId: getFromQuery(req, queryKeys.FnId),
              stepId: getFromQuery(req, queryKeys.StepId),
              data: getBody(req),
              signature: getFromHeaders(req, headerKeys.Signature),
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

function getBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;

  if (body === undefined) {
    throw new Error("missing request body");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("body is not an object");
  }

  return body as Record<string, unknown>;
}

function getFromHeaders(req: Request, key: string): string {
  const value = req.headers[key];

  if (value === undefined) {
    throw new Error(`missing ${key} in request headers`);
  }

  if (typeof value !== "string") {
    throw new Error(`${key} in request headers is not a string`);
  }

  return value;
}

function getFromQuery(req: Request, key: string): string {
  const value = req.query[key];

  if (value === undefined) {
    throw new Error(`missing ${key} in request query`);
  }

  if (typeof value !== "string") {
    throw new Error(`${key} in request query is not a string`);
  }

  return value;
}
