/**
 * @module
 * Calls to the tour server.
 */
import type { Page, TourEvent, TourIndex } from "../../shared/types.ts";

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
  types: () => {
    return get<Record<string, string>>("/api/types");
  },
  output: (id: string) => {
    return get<{
      input: string | null;
      data: string | null;
      error: { message: string } | null;
    }>(`/api/output?id=${encodeURIComponent(id)}`);
  },
  run: (id: string, files: Record<string, string>) => {
    return post("/api/run", { id, files });
  },
  kill: () => {
    return post("/api/kill", {});
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
