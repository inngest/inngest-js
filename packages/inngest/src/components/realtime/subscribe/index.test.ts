import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subscribe } from "./index.ts";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  // biome-ignore lint/suspicious/noExplicitAny: mock surface
  onopen: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mock surface
  onclose: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mock surface
  onerror: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: mock surface
  onmessage: any = null;

  constructor(_url: URL | string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  emitJson(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close(_code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason: reason ?? "client closed" });
  }
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("realtime subscribe helper", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // biome-ignore lint/suspicious/noExplicitAny: mock install
    globalThis.WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  test("returns a stream subscription with unsubscribe()", async () => {
    const stream = await subscribe({
      channel: "test",
      topics: ["status"],
      key: "token",
    });

    expect(typeof stream.unsubscribe).toBe("function");
    expect(typeof stream.close).toBe("function");

    const reader = stream.getReader();
    stream.unsubscribe("done");

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  test("supports callback-style subscriptions via onMessage", async () => {
    const onMessage = vi.fn();

    const handle = await subscribe({
      channel: "test",
      topics: ["status"],
      key: "token",
      onMessage,
    });

    expect("unsubscribe" in handle).toBe(true);

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected websocket instance");
    }

    ws.emitJson({
      kind: "data",
      channel: "test",
      topic: "status",
      data: { message: "hello" },
    });

    await nextTick();
    expect(onMessage).toHaveBeenCalledTimes(1);

    handle.unsubscribe("done");
  });
});
