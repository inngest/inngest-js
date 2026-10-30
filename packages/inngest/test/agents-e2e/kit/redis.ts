/**
 * @module
 * A read-only Redis client (RESP over a socket) for assertions. It lets a
 * scenario read the keys the SDK wrote without adding a Redis dependency.
 */
import { connect } from "node:net";

/**
 * Sends one command and returns the reply: a string, a number, `null` for a
 * missing value, or an array of those.
 */
export const redisCommand = (url: string, args: string[]) => {
  const { hostname, port } = new URL(url);

  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let buffer = Buffer.alloc(0);

    // Parses one reply from the front of `data`; `undefined` when incomplete.
    const parse = (
      data: Buffer,
      at = 0,
    ): { value: unknown; end: number } | undefined => {
      const eol = data.indexOf("\r\n", at);

      if (eol < 0) {
        return undefined;
      }

      const kind = String.fromCharCode(data[at] as number);
      const head = data.toString("utf8", at + 1, eol);

      if (kind === "+" || kind === ":") {
        return { value: kind === ":" ? Number(head) : head, end: eol + 2 };
      }

      if (kind === "-") {
        throw new Error(head);
      }

      if (kind === "$") {
        const length = Number(head);

        if (length < 0) {
          return { value: null, end: eol + 2 };
        }

        if (data.length < eol + 2 + length + 2) {
          return undefined;
        }

        return {
          value: data.toString("utf8", eol + 2, eol + 2 + length),
          end: eol + 2 + length + 2,
        };
      }

      const items: unknown[] = [];
      let end = eol + 2;

      for (let i = 0; i < Number(head); i++) {
        const item = parse(data, end);

        if (!item) {
          return undefined;
        }

        items.push(item.value);
        end = item.end;
      }

      return { value: items, end };
    };

    socket.on("connect", () => {
      const parts = args.map((arg) => {
        return `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
      });

      socket.write(`*${args.length}\r\n${parts.join("")}`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        const reply = parse(buffer);

        if (reply) {
          socket.end();
          resolve(reply.value);
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error("Redis did not answer in 5s"));
    });
    socket.on("close", () => {
      reject(new Error("Redis closed the connection without a reply"));
    });
    socket.on("error", reject);
  });
};
