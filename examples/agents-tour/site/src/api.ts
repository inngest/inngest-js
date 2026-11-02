/**
 * @module
 * Calls to the tour server.
 */
import type {
  CheckResult,
  Page,
  PageFile,
  TourEvent,
  TourIndex,
} from "../../shared/types.ts";

const get = async <T>(path: string) => {
  const res = await fetch(path);

  if (!res.ok) {
    throw new Error(`${path}: ${res.status}`);
  }

  return (await res.json()) as T;
};

const post = async (path: string, body: unknown) => {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return res.ok;
};

export const api = {
  index: () => {
    return get<TourIndex>("/api/index");
  },
  page: (id: string) => {
    return get<Page>(`/api/page?id=${encodeURIComponent(id)}`);
  },
  info: () => {
    return get<{ devServerUrl: string }>("/api/info");
  },
  types: () => {
    return get<Record<string, string>>("/api/types");
  },
  output: (id: string) => {
    return get<{
      input: string | null;
      data: string | null;
      error: { message: string; name: string | null; stack?: string } | null;
    }>(`/api/output?id=${encodeURIComponent(id)}`);
  },
  open: (id: string) => {
    return post("/api/open", { id });
  },
  run: (id: string, files: Record<string, string>) => {
    return post("/api/run", { id, files });
  },
  check: async (id: string, files: Record<string, string>) => {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, files }),
    });

    return (await res.json()) as CheckResult;
  },
  solution: (id: string) => {
    return get<PageFile[]>(`/api/solution?id=${encodeURIComponent(id)}`);
  },
  kill: () => {
    return post("/api/kill", {});
  },
  // The formatted code; the code as given when the server cannot format it.
  format: async (name: string, content: string) => {
    try {
      const res = await fetch("/api/format", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
      const body = (await res.json()) as { content?: string; error?: string };

      if (!res.ok || typeof body.content !== "string") {
        console.error(`Format failed: ${body.error ?? res.status}`);

        return content;
      }

      return body.content;
    } catch (error) {
      console.error(`Format failed: ${String(error)}`);

      return content;
    }
  },
  reset: () => {
    return post("/api/reset", {});
  },
  send: (agent: string, thread: string, message: string) => {
    return post("/api/send", { agent, thread, message });
  },
  stream: (onEvent: (event: TourEvent) => void) => {
    const source = new EventSource("/api/stream");

    source.onmessage = (message) => {
      onEvent(JSON.parse(message.data) as TourEvent);
    };

    return () => {
      source.close();
    };
  },
};
