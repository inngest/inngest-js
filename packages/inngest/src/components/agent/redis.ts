/**
 * @module
 * A minimal Redis client (RESP2 over TCP or TLS) with just the commands the
 * experimental KV needs, so the SDK takes no Redis dependency.
 */
import * as net from "node:net";
import * as tls from "node:tls";

type Reply = string | number | null | Error | Reply[];

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

/**
 * Encodes a command as a RESP array of bulk strings.
 * @param args Command name and arguments.
 */
export function encodeCommand(args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  const chunks: Buffer[] = [];

  for (const arg of args) {
    const bytes = Buffer.from(arg, "utf8");
    chunks.push(
      Buffer.from(`$${bytes.length}\r\n`),
      bytes,
      Buffer.from("\r\n"),
    );
  }

  return Buffer.concat([Buffer.from(parts[0] as string), ...chunks]);
}

/**
 * Parses one reply from the front of `buf`, or returns `undefined` when more
 * bytes are needed.
 * @param buf Received bytes.
 * @param at Offset to parse from.
 */
export function parseReply(
  buf: Buffer,
  at = 0,
): { reply: Reply; end: number } | undefined {
  const lineEnd = buf.indexOf("\r\n", at);
  if (lineEnd === -1) {
    return undefined;
  }

  const type = String.fromCharCode(buf[at] as number);
  const line = buf.toString("utf8", at + 1, lineEnd);
  const next = lineEnd + 2;

  if (type === "+") {
    return { reply: line, end: next };
  }
  if (type === "-") {
    // An error reply is a value: nested in an array it must not desync the
    // bytes that follow it. The caller rejects when it is the whole reply.
    return { reply: new Error(line), end: next };
  }
  if (type === ":") {
    return { reply: Number(line), end: next };
  }
  if (type === "$") {
    const length = Number(line);
    if (length === -1) {
      return { reply: null, end: next };
    }
    if (buf.length < next + length + 2) {
      return undefined;
    }

    return {
      reply: buf.toString("utf8", next, next + length),
      end: next + length + 2,
    };
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) {
      return { reply: null, end: next };
    }

    const items: Reply[] = [];
    let offset = next;
    for (let i = 0; i < count; i++) {
      const item = parseReply(buf, offset);
      if (!item) {
        return undefined;
      }
      items.push(item.reply);
      offset = item.end;
    }

    return { reply: items, end: offset };
  }

  throw new Error(`Unexpected Redis reply type ${type}`);
}

export interface RedisClient {
  command(...args: string[]): Promise<Reply>;
  close(): void;
  isClosed(): boolean;
}

/**
 * Connects to a `redis://` or `rediss://` URL. Commands run in order over one
 * connection.
 * @param url Redis URL, with optional user, password and database.
 */
export async function connectRedis(url: string): Promise<RedisClient> {
  const parsed = new URL(url);
  const secure = parsed.protocol === "rediss:";
  const port = Number(parsed.port || 6379);
  const host = parsed.hostname;

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    s.once(secure ? "secureConnect" : "connect", () => {
      resolve(s);
    });
    s.once("error", reject);
  });

  const pending: Pending[] = [];
  let buffer = Buffer.alloc(0);

  function fail(error: Error) {
    for (const p of pending.splice(0)) {
      p.reject(error);
    }
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      const waiting = pending[0];
      if (!waiting) {
        return;
      }

      let parsedReply: ReturnType<typeof parseReply>;
      try {
        parsedReply = parseReply(buffer);
      } catch (error) {
        fail(error as Error);
        socket.destroy();

        return;
      }
      if (!parsedReply) {
        return;
      }

      buffer = buffer.subarray(parsedReply.end);
      pending.shift();

      if (parsedReply.reply instanceof Error) {
        waiting.reject(parsedReply.reply);
      } else {
        waiting.resolve(parsedReply.reply);
      }
    }
  });
  socket.on("error", fail);
  socket.on("close", () => {
    fail(new Error("Redis connection closed"));
  });

  let dead = false;
  socket.on("close", () => {
    dead = true;
  });

  const client: RedisClient = {
    command(...args) {
      return new Promise((resolve, reject) => {
        if (dead) {
          reject(new Error("Redis connection closed"));

          return;
        }
        pending.push({ resolve, reject });
        socket.write(encodeCommand(args));
      });
    },
    close() {
      socket.destroy();
    },
    isClosed() {
      return dead;
    },
  };

  try {
    if (parsed.password) {
      const auth = ["AUTH"];
      if (parsed.username) {
        auth.push(decodeURIComponent(parsed.username));
      }
      auth.push(decodeURIComponent(parsed.password));
      await client.command(...auth);
    }
    const db = parsed.pathname.replace("/", "");
    if (db) {
      await client.command("SELECT", db);
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }

  return client;
}

/**
 * Returns a function that gives the shared connection to `url`, connecting on
 * first use and again after the connection fails or closes.
 * @param url Redis URL.
 */
export function redisConnection(url: string): () => Promise<RedisClient> {
  let connection: Promise<RedisClient> | undefined;

  return async function client() {
    if (connection) {
      try {
        const current = await connection;
        if (!current.isClosed()) {
          return current;
        }
      } catch {
        // A failed connect is retried below.
      }
    }

    const fresh = connectRedis(url);
    connection = fresh;

    return fresh;
  };
}
