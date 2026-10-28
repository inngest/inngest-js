/**
 * @module
 * Tests for the minimal Redis client against a fake RESP server.
 */
import * as net from "node:net";
import {
  connectRedis,
  encodeCommand,
  parseReply,
  redisConnection,
} from "./redis.ts";

describe("RESP", () => {
  test("encodes commands as bulk string arrays", () => {
    expect(encodeCommand(["SET", "k", "é"]).toString()).toBe(
      "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n",
    );
  });

  test("parses each reply type and waits for partial input", () => {
    expect(parseReply(Buffer.from("+OK\r\n"))?.reply).toBe("OK");
    expect(parseReply(Buffer.from(":42\r\n"))?.reply).toBe(42);
    expect(parseReply(Buffer.from("$-1\r\n"))?.reply).toBeNull();
    expect(parseReply(Buffer.from("$3\r\nabc\r\n"))?.reply).toBe("abc");
    expect(parseReply(Buffer.from("*2\r\n$1\r\na\r\n:1\r\n"))?.reply).toEqual([
      "a",
      1,
    ]);
    expect(parseReply(Buffer.from("$3\r\nab"))).toBeUndefined();
    expect(parseReply(Buffer.from("-ERR bad\r\n"))?.reply).toEqual(
      new Error("ERR bad"),
    );
    // An error nested in an array does not desync what follows it.
    const nested = parseReply(Buffer.from("*2\r\n-ERR x\r\n:7\r\n+OK\r\n"));
    expect(nested?.reply).toEqual([new Error("ERR x"), 7]);
    expect(nested?.end).toBe("*2\r\n-ERR x\r\n:7\r\n".length);
  });

  test("runs commands in order over one connection", async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        seen.push(text);
        socket.write(text.includes("PING") ? "+PONG\r\n" : "$2\r\nhi\r\n");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as net.AddressInfo;

    const client = await connectRedis(`redis://127.0.0.1:${port}`);
    expect(await client.command("PING")).toBe("PONG");
    expect(await client.command("GET", "k")).toBe("hi");

    client.close();
    server.close();
  });

  test("a shared connection reconnects after the socket closes", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => {
        socket.write("+PONG\r\n");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    const client = redisConnection(`redis://127.0.0.1:${port}`);

    expect(await (await client()).command("PING")).toBe("PONG");

    sockets[0]?.destroy();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(await (await client()).command("PING")).toBe("PONG");
    expect(sockets).toHaveLength(2);

    (await client()).close();
    server.close();
  });

  test("a transaction sends one block and keeps replies aligned", async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = parseReply(buffer);
          if (!parsed) {
            return;
          }
          buffer = buffer.subarray(parsed.end);
          const args = parsed.reply as string[];
          seen.push(args[0] as string);
          if (args[0] === "MULTI") {
            socket.write("+OK\r\n");
          } else if (args[0] === "EXEC") {
            socket.write(
              seen.includes("BAD")
                ? "*2\r\n:1\r\n-WRONGTYPE bad\r\n"
                : "*2\r\n:1\r\n:1\r\n",
            );
          } else if (args[0] === "PING") {
            socket.write("+PONG\r\n");
          } else {
            socket.write("+QUEUED\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    const client = await connectRedis(`redis://127.0.0.1:${port}`);

    expect(
      await client.transaction([
        ["DEL", "a"],
        ["HSET", "b"],
      ]),
    ).toEqual([1, 1]);
    expect(await client.command("PING")).toBe("PONG");
    expect(seen).toEqual(["MULTI", "DEL", "HSET", "EXEC", "PING"]);

    await expect(client.transaction([["BAD"]])).rejects.toThrow(/WRONGTYPE/);
    expect(await client.command("PING")).toBe("PONG");

    client.close();
    server.close();
  });
});
