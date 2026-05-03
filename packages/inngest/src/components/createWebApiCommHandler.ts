import type { RegisterOptions, SupportedFrameworkName } from "../types.ts";
import type { Inngest } from "./Inngest.ts";
import {
  InngestCommHandler,
  type SyncHandlerOptions,
} from "./InngestCommHandler.ts";

/**
 * Creates an {@link InngestCommHandler} that uses Web API `Request`/`Response`.
 *
 * This is shared by the edge and Node.js adapters so the handler logic isn't
 * duplicated.
 */
export const createWebApiCommHandler = (
  frameworkName: SupportedFrameworkName,
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
): InngestCommHandler => {
  return new InngestCommHandler({
    frameworkName,
    ...options,
    syncOptions,
    handler: (req: Request) => {
      return {
        body: () => req.text(),
        headers: (key: string) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
        experimentalTransformSyncResponse: async (data) => {
          const res = data as Response;

          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });

          return {
            headers,
            status: res.status,
            body: await res.clone().text(),
          };
        },
      };
    },
  });
};
