import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type SupportedFrameworkName } from "./types";

type HTTP = {
  headers: Record<string, string>;
  method: string;
  path: string;
};

type Main =
  | {
      http?: HTTP;
      // data can include any JSON-decoded post-data, and query args/saerch params.
      [data: string]: unknown;
    }
  | undefined;

export const frameworkName: SupportedFrameworkName = "digitalocean";

export const serve = (
  options: ServeHandlerOptions &
    Required<Pick<NonNullable<ServeHandlerOptions>, "serveHost">>
) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (main: Main = {}) => {
      const { http = { method: "GET", headers: {}, path: "" }, ...data } = main;

      return {
        body: () => data || {},
        headers: (key) => http?.headers?.[key],
        method: () => http.method,
        url: () => new URL(`${options.serveHost}${options.servePath || "/"}`),
        queryString: (key) => main[key] as string,
        transformResponse: (res) => res,
      };
    },
  });

  return handler.createHandler();
};
