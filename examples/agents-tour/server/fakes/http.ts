/**
 * @module
 * A minimal router: `router.route("GET", "/a/:id", handler)`. Handlers return
 * JSON or throw `HttpError`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

export interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

type Handler = (request: Request) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const createRouter = () => {
  const routes: Route[] = [];

  return {
    route: (method: string, path: string, handler: Handler) => {
      const names: string[] = [];
      const source = path.replace(/:(\w+)/g, (_match, name: string) => {
        names.push(name);

        return "([^/]+)";
      });

      routes.push({
        method,
        pattern: new RegExp(`^${source}$`),
        names,
        handler,
      });
    },

    /**
     * Runs the matching route. Returns false when none matches.
     */
    dispatch: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      for (const found of routes) {
        const match = found.pattern.exec(url.pathname);

        if (found.method !== req.method || !match) {
          continue;
        }

        try {
          const params = Object.fromEntries(
            found.names.map((name, index) => {
              return [name, decodeURIComponent(match[index + 1] ?? "")];
            }),
          );
          const result = await found.handler({
            params,
            query: url.searchParams,
            body: await readBody(req),
          });

          if (!res.headersSent) {
            send(res, 200, result ?? {});
          }
        } catch (error) {
          if (error instanceof URIError) {
            send(res, 400, { message: "Bad request path" });
          } else if (error instanceof HttpError) {
            send(res, error.status, error.body);
          } else {
            send(res, 500, { message: String(error) });
          }
        }

        return true;
      }

      return false;
    },
  };
};

export type Router = ReturnType<typeof createRouter>;
