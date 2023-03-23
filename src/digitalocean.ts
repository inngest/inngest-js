import type { ServeHandler } from "./components/InngestCommHandler";
import { InngestCommHandler } from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";

type HTTP = {
  headers: Record<string, string>;
  method: string;
  path: string;
};

type Main = {
  http: HTTP;
  // data can include any JSON-decoded post-data, and query args/saerch params.
  [data: string]: unknown;
};

export const serve = (
  name: Parameters<ServeHandler>[0],
  fns: Parameters<ServeHandler>[1],
  opts: Parameters<ServeHandler>[2] &
    Required<Pick<NonNullable<Parameters<ServeHandler>[2]>, "serveHost">>
) => {
  const handler = new InngestCommHandler(
    "digitalocean",
    name,
    fns,
    opts,
    (main: Main) => {
      // Copy all params as data.
      let { http, ...data } = main || {};

      if (http === undefined) {
        // This is an invocation from the DigitalOcean UI;  main is an empty object.
        // In this case provide some defaults so that this doesn't run functions.
        http = { method: "GET", headers: {}, path: "" };
        data = {};
      }

      // serveHost and servePath must be defined when running in DigitalOcean in order
      // for the SDK to properly register and run functions.
      //
      // DigitalOcean provides no hostname or path in its arguments during execution.
      const url = new URL(`${opts.serveHost}${opts?.servePath || "/"}`);

      return {
        url,
        register: () => {
          if (http.method === "PUT") {
            return {
              deployId: main[queryKeys.DeployId] as string,
            };
          }
        },
        run: () => {
          if (http.method === "POST") {
            return {
              data: data as Record<string, unknown>,
              fnId: (main[queryKeys.FnId] as string) || "",
              stepId: (main[queryKeys.StepId] as string) || "",
              signature: http.headers[headerKeys.Signature] as string,
            };
          }
        },
        view: () => {
          if (http.method === "GET") {
            return {
              isIntrospection: Object.hasOwnProperty.call(
                main,
                queryKeys.Introspect
              ),
            };
          }
        },
      };
    },
    (res) => res
  );
  return handler.createHandler();
};
