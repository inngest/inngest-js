import type { ServeHandler } from "./components/InngestCommHandler";
import { InngestCommHandler } from "./components/InngestCommHandler";
import { headerKeys, queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";

type HTTP = {
  headers: Record<string, string>;
  method: string;
  path: string;
};

type Main = {
  http: HTTP;
  // data can include any JSON-decoded post-data, and query args/saerch params.
  [data: string]: any;
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

      const env = allProcessEnv();
      const isProduction = env.NODE_ENV !== "development";

      // serveHost and servePath must be defined when running in DigitalOcean in order
      // for the SDK to properly register and run functions.
      //
      // DigitalOcean provides no hostname or path in its arguments during execution.
      const url = new URL(`${opts.serveHost}${opts?.servePath || "/"}`);

      return {
        register: () => {
          if (http.method === "PUT") {
            return {
              env,
              url,
              isProduction,
              deployId: main[queryKeys.DeployId] as string,
            };
          }
        },
        run: () => {
          if (http.method === "POST") {
            return {
              data: data as Record<string, any>,
              fnId: (main[queryKeys.FnId] as string) || "",
              stepId: (main[queryKeys.StepId] as string) || "",
              env,
              isProduction,
              url,
              signature: http.headers[headerKeys.Signature] as string,
            };
          }
        },
        view: () => {
          if (http.method === "GET") {
            return {
              env,
              isIntrospection: Object.hasOwnProperty.call(
                main,
                queryKeys.Introspect
              ),
              url,
              isProduction,
            };
          }
        },
      };
    },
    (res) => res
  );
  return handler.createHandler();
};
