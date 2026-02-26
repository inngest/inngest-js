import { z } from "zod/v3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TokenSubscription } from "./TokenSubscription.ts";

type WsBehavior = "open" | "close-before-open";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static behavior: WsBehavior = "open";

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
      if (MockWebSocket.behavior === "close-before-open") {
        this.emitClose("rejected");
        return;
      }

      this.emitOpen();
    }, 0);
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(reason = "closed") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason });
  }

  emitError(error: unknown = new Error("socket error")) {
    this.onerror?.(error);
  }

  emitJson(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close(_code?: number, reason?: string) {
    this.emitClose(reason ?? "client closed");
  }
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TokenSubscription", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.behavior = "open";
    // biome-ignore lint/suspicious/noExplicitAny: mock install
    globalThis.WebSocket = MockWebSocket as any;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  test("connect rejects if the socket closes before opening", async () => {
    MockWebSocket.behavior = "close-before-open";

    const sub = new TokenSubscription({
      token: {
        channel: "test",
        topics: ["status"],
        key: "token",
      } as never,
    });

    await expect(sub.connect()).rejects.toThrow("before opening");
  });

  test("emits lifecycle run messages", async () => {
    const sub = new TokenSubscription({
      token: {
        channel: "test",
        topics: ["status"],
        key: "token",
      } as never,
    });

    const stream = sub.getJsonStream();
    const reader = stream.getReader();

    await sub.connect();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected websocket instance");
    }
    ws.emitJson({
      kind: "run",
      channel: "test",
      data: { status: "completed", result: { ok: true } },
      run_id: "run_1",
    });

    const message = await reader.read();
    expect(message.done).toBe(false);
    expect(message.value?.kind).toBe("run");
    expect(message.value?.runId).toBe("run_1");
  });

  test("skips schema validation when validate=false", async () => {
    const sub = new TokenSubscription({
      token: {
        channel: {
          name: "test",
          topics: {
            status: { schema: z.object({ message: z.string() }) },
          },
        } as never,
        topics: ["status"],
        key: "token",
      },
      validate: false,
    });

    const reader = sub.getJsonStream().getReader();
    await sub.connect();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected websocket instance");
    }

    ws.emitJson({
      kind: "data",
      channel: "test",
      topic: "status",
      data: { message: 123 },
    });

    const message = await reader.read();
    expect(message.value).toMatchObject({
      kind: "data",
      topic: "status",
      data: { message: 123 },
    });
  });

  test("close closes the websocket and fanout streams", async () => {
    const sub = new TokenSubscription({
      token: {
        channel: "test",
        topics: ["status"],
        key: "token",
      } as never,
    });

    const reader = sub.getJsonStream().getReader();
    await sub.connect();

    sub.close("test teardown");

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected websocket instance");
    }
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  test("useCallback forwards callback errors to onError", async () => {
    const sub = new TokenSubscription({
      token: {
        channel: "test",
        topics: ["status"],
        key: "token",
      } as never,
    });

    const onError = vi.fn();
    const callback = vi.fn(() => {
      throw new Error("boom");
    });

    await sub.connect();
    sub.useCallback(callback, undefined, onError);

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected websocket instance");
    }

    ws.emitJson({
      kind: "data",
      channel: "test",
      topic: "status",
      data: { ok: true },
    });

    await nextTick();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
