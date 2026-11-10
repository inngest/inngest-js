import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { subscribe } from "./index.ts";

test.each(["server", "subscriber"])(
  "drains accepted messages to slow subscribers when the %s closes",
  async (closer) => {
    const clientSockets: WebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends WebSocket {
        constructor(url: string | URL) {
          super(url);
          clientSockets.push(this);
        }
      },
    );
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    onTestFinished(async () => {
      for (const socket of clientSockets) socket.terminate();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      vi.unstubAllGlobals();
    });
    await once(server, "listening");
    const connection = once(server, "connection");
    const subscription = await subscribe({
      channel: "test",
      topics: ["status"],
      key: "token",
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const [peer] = (await connection) as [WebSocket];
    const fastReader = subscription.getJsonStream().getReader();
    const slowReader = subscription.getReader();
    const encodedReader = subscription.getEncodedStream().getReader();
    const decoder = new TextDecoder();
    onTestFinished(async () => {
      subscription.close();
      await Promise.all([
        fastReader.cancel(),
        slowReader.cancel(),
        encodedReader.cancel(),
      ]);
    });

    for (const data of [1, 2, 3]) {
      peer.send(
        JSON.stringify({
          kind: "data",
          channel: "test",
          topic: "status",
          data,
        }),
      );
      // The fast reader proves each message has reached the fanout before close.
      expect((await fastReader.read()).value?.data).toBe(data);
      if (data === 1) {
        expect((await slowReader.read()).value?.data).toBe(1);
        expect(
          JSON.parse(
            decoder.decode((await encodedReader.read()).value).slice(6),
          ).data,
        ).toBe(1);
      }
    }

    if (closer === "server") {
      const closed = once(clientSockets[0]!, "close");
      peer.close();
      await closed;
    } else {
      subscription.close();
    }

    const remaining: unknown[] = [];
    const encoded: unknown[] = [];
    for (;;) {
      const result = await slowReader.read();
      if (result.done) break;
      remaining.push(result.value.data);
    }
    for (;;) {
      const result = await encodedReader.read();
      if (result.done) break;
      encoded.push(JSON.parse(decoder.decode(result.value).slice(6)).data);
    }
    expect(remaining).toEqual([2, 3]);
    expect(encoded).toEqual([2, 3]);
    expect((await fastReader.read()).done).toBe(true);
  },
);
