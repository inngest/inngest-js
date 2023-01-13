import { InngestCommHandler } from "./components/InngestCommHandler";
import { queryKeys } from "./helpers/consts";
import { allProcessEnv } from "./helpers/env";
import { RegisterOptions } from "./types";
import type { Inngest } from "./components/Inngest";
import type { InngestFunction } from "./components/InngestFunction";

type HTTP = {
  headers: {
    host?: string;
  };
  method: string;
  path: string;
};

type Main = {
  http: HTTP;
  // data can include any JSON-decoded post-data, and query args/saerch params.
  [data: string]: any;
};

/**
 * Opts extends RegisterOptions to make `servePath` and `serveHost` required.
 */
type Opts = RegisterOptions & {
  /**
   * The path to the Inngest serve endpoint. e.g.:
   *
   *     "/some/long/path/to/inngest/endpoint"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/rediects).
   *
   * Provide the custom path (excluding the hostname) here to ensure that the
   * path is reported correctly when registering functions with Inngest.
   *
   * To also provide a custom hostname, use `serveHost`.
   */
  servePath?: string;

  /**
   * The host used to access the Inngest serve endpoint, e.g.:
   *
   *     "https://myapp.com"
   *
   * By default, the library will try to infer this using request details such
   * as the "Host" header and request path, but sometimes this isn't possible
   * (e.g. when running in a more controlled environments such as AWS Lambda or
   * when dealing with proxies/rediects).
   *
   * Provide the custom hostname here to ensure that the path is reported
   * correctly when registering functions with Inngest.
   *
   * To also provide a custom path, use `servePath`.
   */
  serveHost: string;
};

type ServeHandler = (
  /**
   * The name of this app, used to scope and group Inngest functions, or
   * the `Inngest` instance used to declare all functions.
   */
  nameOrInngest: string | Inngest<any>,

  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: InngestFunction<any>[],

  /**
   * A set of options to further configure the registration of Inngest
   * functions.
   */
  opts: Opts
) => any;

export const serve: ServeHandler = (name, fns, opts: Opts) => {
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
      const url = new URL(opts?.serveHost + (opts?.servePath || "/"));

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
              env,
              isProduction,
              url,
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
