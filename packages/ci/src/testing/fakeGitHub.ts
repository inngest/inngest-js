/**
 * A fake GitHub HTTP layer for tests that records every request.
 *
 * @module
 */

export interface FakeGitHubRequest {
  method: string;
  path: string;
  body?: unknown;
  /** The request's `Authorization` header, if it had one. */
  authorization?: string;
}

export interface FakeGitHubReply {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  requests: FakeGitHubRequest[];
  /** Reply to `METHOD /path` with this body. Paths may end in `*`. */
  route(pattern: string, body: unknown, status?: number): void;
  /** Like `route`, but decides from the request, such as who is asking. */
  handle(
    pattern: string,
    reply: (request: FakeGitHubRequest) => FakeGitHubReply,
  ): void;
}

/**
 * A fake GitHub HTTP layer that records every request.
 */
export const createFakeGitHub = (): FakeGitHub => {
  const requests: FakeGitHubRequest[] = [];
  const routes: Array<{
    pattern: string;
    reply: (request: FakeGitHubRequest) => FakeGitHubReply;
  }> = [];

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;

    const authorization = new Headers(init?.headers).get("authorization");

    const request: FakeGitHubRequest = {
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      ...(authorization ? { authorization } : {}),
    };

    requests.push(request);

    const route = routes.find(({ pattern }) => {
      return pattern.endsWith("*")
        ? key.startsWith(pattern.slice(0, -1))
        : pattern === key;
    });

    const reply = route?.reply(request);

    const response = new Response(JSON.stringify(reply?.body ?? {}), {
      status: reply?.status ?? 200,
      headers: { "Content-Type": "application/json", ...reply?.headers },
    });

    // Octokit's pagination reads the request URL from the response.
    Object.defineProperty(response, "url", { value: url.href });

    return response;
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    route: (pattern, body, status = 200) => {
      routes.unshift({
        pattern,
        reply: () => {
          return { body, status };
        },
      });
    },
    handle: (pattern, reply) => {
      routes.unshift({ pattern, reply });
    },
  };
};
