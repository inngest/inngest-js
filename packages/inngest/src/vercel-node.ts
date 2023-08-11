import { type VercelRequest, type VercelResponse } from "@vercel/node";
import {
  InngestCommHandler,
  type ServeHandler,
} from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "vercel/node";

export const serve: ServeHandler = (nameOrInngest, fns, opts) => {
  const handler = new InngestCommHandler(
    name,
    nameOrInngest,
    fns,
    opts,
    (request: VercelRequest, _response: VercelResponse) => {
      const baseUrl = `https://${request.headers.host || ""}`;
      const url = new URL(request.url || "", baseUrl);
      return {
        url,
        register: () => {
          if (request.method === "PUT") {
            return {
              deployId: request.query[queryKeys.DeployId]?.toString(),
            };
          }
        },
        run: () => {
          if (request.method === "POST") {
            return {
              fnId: request.query[queryKeys.FnId] as string,
              stepId: request.query[queryKeys.StepId] as string,
              data: request.body as Record<string, unknown>,
              signature: request.headers[headerKeys.Signature] as string,
            };
          }
        },
        view: () => {
          if (request.method === "GET") {
            return {
              isIntrospection: url.searchParams.has(queryKeys.Introspect),
            };
          }
        },
      };
    },
    ({ body, status, headers }, _request, response) => {
      Object.entries(headers).forEach(([name, value]) => {
        response.setHeader(name, value);
      });

      return response.status(status).send(body);
    }
  );

  return handler.createHandler();
};
