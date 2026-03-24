import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import { subscribe as realtimeSubscribe } from "./components/realtime/subscribe/index.ts";
import type { Realtime } from "./components/realtime/types.ts";
import type { UseRealtimeOptions, UseRealtimeResult } from "./react.ts";
import { useRealtime } from "./react.ts";

vi.mock("./components/realtime/subscribe/index.ts", () => {
  return {
    subscribe: vi.fn(),
    getSubscriptionToken: vi.fn(),
  };
});

type DataMessage = Extract<Realtime.Message, { kind: "data" }>;

const makeDataMessage = (topic: string, data: unknown): DataMessage => {
  return {
    kind: "data",
    channel: "test-channel",
    topic,
    data,
    createdAt: new Date(),
  };
};

const createControlledSubscription = () => {
  const stream = new TransformStream<Realtime.Message, Realtime.Message>();
  const writer = stream.writable.getWriter();

  let closed = false;
  const closeWriter = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await writer.close();
    } catch {
      // no-op
    }
  };

  const unsubscribe = vi.fn((_reason?: string) => {
    void closeWriter();
  });

  const close = vi.fn((_reason?: string) => {
    void closeWriter();
  });

  const subscription = Object.assign(stream.readable, {
    getJsonStream: () => stream.readable,
    getEncodedStream: () => new ReadableStream<Uint8Array>(),
    close,
    unsubscribe,
  }) as Realtime.Subscribe.StreamSubscription;

  return {
    subscription,
    unsubscribe,
    push: async (message: Realtime.Message) => {
      if (closed) {
        return;
      }
      await writer.write(message);
    },
    end: async () => {
      await closeWriter();
    },
  };
};

const renderUseRealtime = async <
  TChannel extends Realtime.ChannelInput,
  TTopics extends readonly string[] | undefined,
>(
  options: UseRealtimeOptions<TChannel, TTopics>,
) => {
  let latest: UseRealtimeResult<TChannel, TTopics> | null = null;

  const onChange = (value: UseRealtimeResult<TChannel, TTopics>) => {
    latest = value;
  };

  const Harness = ({
    opts,
  }: {
    opts: UseRealtimeOptions<TChannel, TTopics>;
  }) => {
    const result = useRealtime(opts);
    onChange(result);
    return null;
  };

  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness, { opts: options }));
  });

  return {
    getLatest: () => latest,
    update: async (nextOptions: UseRealtimeOptions<TChannel, TTopics>) => {
      await act(async () => {
        renderer.update(React.createElement(Harness, { opts: nextOptions }));
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
};

const installFakeDocument = (initial: "visible" | "hidden") => {
  const originalDocument = (globalThis as { document?: Document }).document;
  const listeners = new Set<() => void>();

  const fakeDocument = {
    visibilityState: initial,
    addEventListener: (event: string, listener: EventListener) => {
      if (event === "visibilitychange") {
        listeners.add(listener as () => void);
      }
    },
    removeEventListener: (event: string, listener: EventListener) => {
      if (event === "visibilitychange") {
        listeners.delete(listener as () => void);
      }
    },
  } as unknown as Document;

  (globalThis as { document?: Document }).document = fakeDocument;

  return {
    setVisibility: async (state: "visible" | "hidden") => {
      (
        fakeDocument as { visibilityState: "visible" | "hidden" }
      ).visibilityState = state;
      await act(async () => {
        for (const listener of listeners) {
          listener();
        }
      });
    },
    restore: () => {
      if (typeof originalDocument === "undefined") {
        delete (globalThis as { document?: Document }).document;
      } else {
        (globalThis as { document?: Document }).document = originalDocument;
      }
    },
  };
};

describe("useRealtime runtime behavior", () => {
  const mockedSubscribe = vi.mocked(realtimeSubscribe);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("flushes buffered messages when bufferInterval changes to zero", async () => {
    const sub = createControlledSubscription();
    mockedSubscribe.mockResolvedValue(sub.subscription);

    const options = {
      token: { channel: "test-channel", topics: ["status"], key: "abc" },
      bufferInterval: 1000,
      reconnect: false,
    } satisfies UseRealtimeOptions;

    const hook = await renderUseRealtime(options);

    await vi.waitFor(() => {
      expect(mockedSubscribe).toHaveBeenCalledTimes(1);
      expect(hook.getLatest()?.connectionStatus).toBe("open");
    });

    await act(async () => {
      await sub.push(makeDataMessage("status", { message: "hello" }));
    });

    await vi.waitFor(() => {
      expect(hook.getLatest()?.messages.byTopic["status"]).toBeDefined();
    });
    expect(hook.getLatest()?.messages.all).toHaveLength(0);

    await hook.update({
      ...options,
      bufferInterval: 0,
    });

    await vi.waitFor(() => {
      expect(hook.getLatest()?.messages.all).toHaveLength(1);
      expect(hook.getLatest()?.messages.delta).toHaveLength(1);
    });

    await hook.unmount();
  });

  test("accepts client subscription tokens from token factories", async () => {
    const sub = createControlledSubscription();
    mockedSubscribe.mockResolvedValue(sub.subscription);

    const hook = await renderUseRealtime({
      channel: "test-channel",
      topics: ["status"],
      token: async () => ({
        key: "abc",
        apiBaseUrl: "http://localhost:8288/",
      }),
      reconnect: false,
    });

    await vi.waitFor(() => {
      expect(mockedSubscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "test-channel",
          topics: ["status"],
          key: "abc",
          apiBaseUrl: "http://localhost:8288/",
        }),
      );
      expect(hook.getLatest()?.connectionStatus).toBe("open");
    });

    await hook.unmount();
  });

  test("pauses while hidden and resumes when visible again", async () => {
    const visibility = installFakeDocument("hidden");
    const sub = createControlledSubscription();
    mockedSubscribe.mockResolvedValue(sub.subscription);

    try {
      const hook = await renderUseRealtime({
        token: { channel: "test-channel", topics: ["status"], key: "abc" },
        pauseOnHidden: true,
        reconnect: false,
      });

      await vi.waitFor(() => {
        expect(hook.getLatest()?.connectionStatus).toBe("paused");
        expect(hook.getLatest()?.pauseReason).toBe("hidden");
        expect(mockedSubscribe).toHaveBeenCalledTimes(0);
      });

      await visibility.setVisibility("visible");

      await vi.waitFor(() => {
        expect(mockedSubscribe).toHaveBeenCalledTimes(1);
        expect(hook.getLatest()?.connectionStatus).toBe("open");
        expect(hook.getLatest()?.pauseReason).toBe(null);
      });

      await visibility.setVisibility("hidden");

      await vi.waitFor(() => {
        expect(hook.getLatest()?.connectionStatus).toBe("paused");
        expect(hook.getLatest()?.pauseReason).toBe("hidden");
        expect(sub.unsubscribe).toHaveBeenCalled();
      });

      await hook.unmount();
    } finally {
      visibility.restore();
    }
  });

  test("reconnects after the stream closes when reconnect is enabled", async () => {
    const first = createControlledSubscription();
    const second = createControlledSubscription();

    mockedSubscribe
      .mockResolvedValueOnce(first.subscription)
      .mockResolvedValueOnce(second.subscription);

    const hook = await renderUseRealtime({
      token: { channel: "test-channel", topics: ["status"], key: "abc" },
      reconnect: true,
      reconnectMinMs: 0,
      reconnectMaxMs: 0,
    });

    await vi.waitFor(() => {
      expect(mockedSubscribe).toHaveBeenCalledTimes(1);
      expect(hook.getLatest()?.connectionStatus).toBe("open");
    });

    await act(async () => {
      await first.end();
    });

    await vi.waitFor(() => {
      expect(mockedSubscribe).toHaveBeenCalledTimes(2);
      expect(hook.getLatest()?.connectionStatus).toBe("open");
    });

    await hook.unmount();
  });
});
