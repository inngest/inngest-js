/**
 * A fake GitHub HTTP layer for tests that records every request.
 *
 * @module
 */

export interface FakeGitHubRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  requests: FakeGitHubRequest[];
  /** Reply to `METHOD /path` with this body. Paths may end in `*`. */
  route(pattern: string, body: unknown, status?: number): void;
}

/**
 * A fake GitHub HTTP layer that records every request.
 */
export const createFakeGitHub = (): FakeGitHub => {
  const requests: FakeGitHubRequest[] = [];
  const routes: Array<{ pattern: string; body: unknown; status: number }> = [];

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;

    requests.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });

    const route = routes.find(({ pattern }) =>
      pattern.endsWith("*")
        ? key.startsWith(pattern.slice(0, -1))
        : pattern === key,
    );

    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    route: (pattern, body, status = 200) => {
      routes.unshift({ pattern, body, status });
    },
  };
};
