import type { NextApiRequest, NextApiResponse } from "next";
import { NextRequest } from "next/server";
import {
  InngestCommHandler,
  ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { isEdgeRuntime, processEnv } from "./helpers/env";
import { RegisterOptions } from "./types";

export const name = "nextjs";

/**
 * Assert whether the given request is a Next.js API request or an `NextRequest`
 * from an edge function.
 */
const isEdgeRequest = (
  req: NextApiRequest | NextRequest
): req is NextRequest => {
  return typeof req?.headers?.get === "function";
};

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const optsWithFetch: RegisterOptions = { ...opts };

  if (typeof fetch !== "undefined" && isEdgeRuntime()) {
    optsWithFetch.fetch = fetch.bind(globalThis);
  }

  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    optsWithFetch,
    (req: NextApiRequest | NextRequest, _res: NextApiResponse) => {
      const isEdge = isEdgeRequest(req);

      const url = isEdge
        ? new URL(req.url)
        : new URL(
            req.url as string,
            `${processEnv("NODE_ENV") === "development" ? "http" : "https"}://${
              req.headers.host || ""
            }`
          );

      const getQueryParam = (key: string): string | undefined => {
        return (
          (isEdge ? url.searchParams.get(key) : req.query[key]?.toString()) ??
          undefined
        );
      };

      const hasQueryParam = (key: string): boolean => {
        return (
          (isEdge
            ? url.searchParams.has(key)
            : Object.hasOwnProperty.call(req.query, key)) ?? false
        );
      };

      const getHeader = (key: string): string | undefined => {
        return (
          (isEdge ? req.headers.get(key) : req.headers[key]?.toString()) ??
          undefined
        );
      };

      return {
        url,
        register: () => {
          if (req.method === "PUT") {
            return {
              deployId: getQueryParam(queryKeys.DeployId)?.toString(),
            };
          }
        },
        run: async () => {
          if (req.method === "POST") {
            return {
              data: isEdge
                ? ((await req.json()) as Record<string, unknown>)
                : (req.body as Record<string, unknown>),
              fnId: getQueryParam(queryKeys.FnId) as string,
              stepId: getQueryParam(queryKeys.StepId) as string,
              signature: getHeader(headerKeys.Signature) as string,
            };
          }
        },
        view: () => {
          if (req.method === "GET") {
            return {
              isIntrospection: hasQueryParam(queryKeys.Introspect),
            };
          }
        },
      };
    },
    ({ body, headers, status }, _req, res) => {
      if ("send" in res) {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }

        return void res.status(status).send(body);
      }

      return new Response(body, { status, headers });
    }
  );

  return handler.createHandler();
};
