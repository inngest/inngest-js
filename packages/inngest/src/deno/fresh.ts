import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "../components/InngestCommHandler";
import { type SupportedFrameworkName } from "../types";

export const frameworkName: SupportedFrameworkName = "deno/fresh";

/**
 * With Deno's Fresh framework, serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (req: Request, env: Record<string, string>) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        env: () => env,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

  const fn = handler.createHandler();

  return function handleRequest(req: Request) {
    return fn(req, Deno.env.toObject());
  };
};

declare const Deno: { env: { toObject: () => { [index: string]: string } } };
