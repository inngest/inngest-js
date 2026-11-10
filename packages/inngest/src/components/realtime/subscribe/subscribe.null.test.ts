import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod/v3";
import { channel } from "../channel.ts";
import { subscribe } from "./index.ts";

test.each(["typed", "untyped", "validation disabled"])(
  "preserves null payloads in %s subscriptions",
  async (mode) => {
    vi.stubGlobal("WebSocket", WebSocket);
    const validationError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    onTestFinished(async () => {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    await once(server, "listening");
    const connection = once(server, "connection");
    const status = channel({
      name: "test",
      topics: { status: { schema: z.string().nullable() } },
    });
    const subscription = await subscribe({
      channel: mode === "untyped" ? "test" : status,
      topics: ["status"],
      key: "token",
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      validate: mode !== "validation disabled",
    });
    const reader = subscription.getReader();
    const encodedReader = subscription.getEncodedStream().getReader();
    onTestFinished(async () => {
      subscription.close();
      await Promise.all([reader.cancel(), encodedReader.cancel()]);
    });
    const [peer] = (await connection) as [WebSocket];
    for (const data of ["before", null, "after"]) {
      peer.send(
        JSON.stringify({
          kind: "data",
          channel: "test",
          topic: "status",
          data,
        }),
      );
    }

    const decoder = new TextDecoder();
    for (const data of ["before", null, "after"]) {
      expect((await reader.read()).value).toHaveProperty("data", data);
      const encoded = (await encodedReader.read()).value;
      expect(JSON.parse(decoder.decode(encoded).slice(6))).toHaveProperty(
        "data",
        data,
      );
    }
    expect(validationError).not.toHaveBeenCalled();
  },
);
