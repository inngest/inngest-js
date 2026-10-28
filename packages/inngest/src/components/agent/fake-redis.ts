/**
 * @module
 * A small fake Redis server (RESP2) for tests: the commands the experimental
 * KV uses, with key expiry driven by a clock the test moves.
 */
import * as net from "node:net";
import { parseReply } from "./redis.ts";

type Value =
  | { type: "string"; value: string; expiresAt?: number }
  | { type: "hash"; value: Map<string, string> }
  | { type: "zset"; value: Map<string, number> };

/**
 * Starts the server on a free local port.
 */
export async function startFakeRedis() {
  const data = new Map<string, Value>();
  const state = { now: 0 };
  const sockets = new Set<net.Socket>();

  function live(key: string) {
    const found = data.get(key);
    if (found?.type === "string" && found.expiresAt !== undefined) {
      if (found.expiresAt <= state.now) {
        data.delete(key);

        return undefined;
      }
    }

    return found;
  }

  function bulk(value: string | null) {
    return value === null
      ? "$-1\r\n"
      : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }

  function array(items: string[]) {
    return `*${items.length}\r\n${items.map(bulk).join("")}`;
  }

  function execute(args: string[]): string {
    const [name, ...rest] = args;
    const a = rest as string[];
    switch ((name as string).toUpperCase()) {
      case "HGET": {
        const h = live(a[0] as string);

        return bulk(
          h?.type === "hash" ? (h.value.get(a[1] as string) ?? null) : null,
        );
      }
      case "HSET": {
        let h = live(a[0] as string);
        if (!h) {
          h = { type: "hash", value: new Map() };
          data.set(a[0] as string, h);
        }
        (h as { value: Map<string, string> }).value.set(
          a[1] as string,
          a[2] as string,
        );

        return ":1\r\n";
      }
      case "HDEL": {
        const h = live(a[0] as string);
        const had = h?.type === "hash" && h.value.delete(a[1] as string);

        return `:${had ? 1 : 0}\r\n`;
      }
      case "HEXISTS": {
        const h = live(a[0] as string);

        return `:${h?.type === "hash" && h.value.has(a[1] as string) ? 1 : 0}\r\n`;
      }
      case "HGETALL": {
        const h = live(a[0] as string);

        return array(
          h?.type === "hash" ? [...h.value].flatMap(([k, v]) => [k, v]) : [],
        );
      }
      case "GET": {
        const v = live(a[0] as string);

        return bulk(v?.type === "string" ? v.value : null);
      }
      case "SET": {
        const [key, value, ...options] = a as string[];
        let expiresAt: number | undefined;
        let nx = false;
        for (let i = 0; i < options.length; i++) {
          const option = (options[i] as string).toUpperCase();
          if (option === "EX") {
            expiresAt = state.now + Number(options[++i]) * 1000;
          } else if (option === "NX") {
            nx = true;
          }
        }
        if (nx && live(key as string)) {
          return "$-1\r\n";
        }
        data.set(key as string, {
          type: "string",
          value: value as string,
          expiresAt,
        });

        return "+OK\r\n";
      }
      case "MGET": {
        return `*${a.length}\r\n${a
          .map((key) => {
            const v = live(key);

            return bulk(v?.type === "string" ? v.value : null);
          })
          .join("")}`;
      }
      case "DEL": {
        let count = 0;
        for (const key of a) {
          if (live(key)) {
            data.delete(key);
            count++;
          }
        }

        return `:${count}\r\n`;
      }
      case "TIME": {
        return array([
          String(Math.floor(state.now / 1000)),
          String((state.now % 1000) * 1000),
        ]);
      }
      case "HSETNX": {
        let h = live(a[0] as string);
        if (!h) {
          h = { type: "hash", value: new Map() };
          data.set(a[0] as string, h);
        }
        const hash = (h as { value: Map<string, string> }).value;
        if (hash.has(a[1] as string)) {
          return ":0\r\n";
        }
        hash.set(a[1] as string, a[2] as string);

        return ":1\r\n";
      }
      case "EXISTS": {
        return `:${a.filter((key) => live(key)).length}\r\n`;
      }
      case "ZCARD": {
        const z = live(a[0] as string);

        return `:${z?.type === "zset" ? z.value.size : 0}\r\n`;
      }
      case "ZREMRANGEBYSCORE": {
        const z = live(a[0] as string);
        let count = 0;
        if (z?.type === "zset") {
          const hi = Number(a[2]);
          for (const [member, score] of [...z.value]) {
            if (score <= hi) {
              z.value.delete(member);
              count++;
            }
          }
        }

        return `:${count}\r\n`;
      }
      case "ZADD": {
        const gt = a[1]?.toUpperCase() === "GT";
        const [score, member] = gt ? [a[2], a[3]] : [a[1], a[2]];
        let z = live(a[0] as string);
        if (!z) {
          z = { type: "zset", value: new Map() };
          data.set(a[0] as string, z);
        }
        const zset = (z as { value: Map<string, number> }).value;
        const next = score === "+inf" ? Infinity : Number(score);
        if (!gt || next > (zset.get(member as string) ?? -Infinity)) {
          zset.set(member as string, next);
        }

        return ":1\r\n";
      }
      case "ZREM": {
        const z = live(a[0] as string);

        return `:${z?.type === "zset" && z.value.delete(a[1] as string) ? 1 : 0}\r\n`;
      }
      case "ZRANGEBYSCORE":
      case "ZREVRANGEBYSCORE": {
        const desc = (name as string).toUpperCase() === "ZREVRANGEBYSCORE";
        const bound = (x: string) => {
          return x === "-inf" ? -Infinity : x === "+inf" ? Infinity : Number(x);
        };
        const lo = bound((desc ? a[2] : a[1]) as string);
        const hi = bound((desc ? a[1] : a[2]) as string);
        const z = live(a[0] as string);
        let entries =
          z?.type === "zset"
            ? [...z.value]
                .filter(([, s]) => {
                  return s >= lo && s <= hi;
                })
                .sort((x, y) => {
                  return x[1] - y[1] || (x[0] < y[0] ? -1 : 1);
                })
            : [];
        if (desc) {
          entries.reverse();
        }
        const limitAt = a.findIndex((x) => x.toUpperCase() === "LIMIT");
        if (limitAt >= 0) {
          entries = entries.slice(0, Number(a[limitAt + 2]));
        }

        const withScores = a.some((x) => {
          return x.toUpperCase() === "WITHSCORES";
        });

        return array(
          entries.flatMap(([m, s]) => {
            return withScores ? [m, String(s)] : [m];
          }),
        );
      }
      default:
        return `-ERR unknown command ${name}\r\n`;
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseReply(buffer);
        if (!parsed) {
          return;
        }
        buffer = buffer.subarray(parsed.end);
        socket.write(execute(parsed.reply as string[]));
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `redis://127.0.0.1:${port}`,

    /**
     * Moves the server clock forward.
     * @param ms Milliseconds to add.
     */
    advance(ms: number) {
      state.now += ms;
    },

    /**
     * The members of a sorted set.
     * @param key Key of the set.
     */
    members(key: string) {
      const found = data.get(key);

      return found?.type === "zset" ? [...found.value.keys()].sort() : [];
    },
    keys() {
      return [...data.keys()].sort();
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}
