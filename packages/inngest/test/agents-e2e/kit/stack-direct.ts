/**
 * @module
 * The same stack as `stack.ts` without devstack, for machines that don't have
 * it, such as the CI sandbox: it starts the Dev Server binary
 * (`AGENTS_VERIFY_DEV_BIN`), Redis (`AGENTS_VERIFY_REDIS_CMD`, default
 * `redis-server`) and the app as child processes on free ports, and stops
 * exactly those children (each in its own process group). Chosen with
 * `AGENTS_VERIFY_STACK=direct`. It cannot build or pick a backend: a scenario
 * with `needs.oss` runs against whatever `AGENTS_VERIFY_DEV_BIN` is. Process
 * output is kept and printed when setup fails; `AGENTS_VERIFY_VERBOSE=1`
 * prints it live.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { redisCommand } from "./redis.ts";
import type { Stack, StartOptions } from "./stack.ts";

interface Started {
  label: string;
  child: ChildProcess;
  tail: string;
  exited?: string;
}

const started: Started[] = [];

const freePort = () => {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });
};

const start = (
  label: string,
  command: string,
  args: string[],
  env: Record<string, string>,
) => {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const entry: Started = { label, child, tail: "" };
  const keep = (chunk: Buffer) => {
    if (process.env.AGENTS_VERIFY_VERBOSE) {
      process.stdout.write(chunk);
    }

    entry.tail = (entry.tail + chunk.toString()).slice(-4096);
  };

  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (error) => {
    entry.exited = error.message;
  });
  child.on("exit", (code, signal) => {
    entry.exited = `exited with ${signal ?? code}`;
  });
  started.push(entry);
};

const describeFailures = () => {
  return started
    .map((entry) => {
      return `--- ${entry.label}${entry.exited ? ` (${entry.exited})` : ""}\n${entry.tail}`;
    })
    .join("\n");
};

const waitFor = async (
  what: string,
  ready: () => Promise<boolean>,
  ms = 60_000,
) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const dead = started.find((entry) => {
      return entry.exited;
    });

    if (dead) {
      throw new Error(
        `${dead.label} ${dead.exited} while waiting for ${what}\n${describeFailures()}`,
      );
    }

    if (await ready().catch(() => false)) {
      return;
    }

    await sleep(300);
  }

  throw new Error(
    `${what} was not ready after ${ms / 1000}s\n${describeFailures()}`,
  );
};

const get = (url: string, init: RequestInit = {}) => {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
};

export const startStack = async (options: StartOptions): Promise<Stack> => {
  const devBin = process.env.AGENTS_VERIFY_DEV_BIN;

  if (!devBin) {
    throw new Error(
      "AGENTS_VERIFY_STACK=direct needs AGENTS_VERIFY_DEV_BIN, the path of the Dev Server binary",
    );
  }

  const [devPort, redisPort, appPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const devUrl = `http://127.0.0.1:${devPort}`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const redis = (
    process.env.AGENTS_VERIFY_REDIS_CMD ??
    "redis-server --bind 127.0.0.1 --port $PORT --save '' --appendonly no"
  ).replaceAll("$PORT", String(redisPort));

  start(
    "Dev Server",
    devBin,
    [
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(devPort),
      "--no-discovery",
      "--no-poll",
      "--retry-interval",
      "1",
      "--tick",
      "10",
    ],
    {},
  );
  start("Redis", "sh", ["-c", `exec ${redis}`], {});

  await waitFor("the Dev Server", async () => {
    return (await get(`${devUrl}/dev`)).ok;
  });
  await waitFor("Redis", async () => {
    return (await redisCommand(redisUrl, ["PING"])) === "PONG";
  });

  start("app", "sh", ["-c", `exec ${options.appCommand}`], {
    ...options.appEnv,
    PORT: String(appPort),
    INNGEST_DEV: "1",
    INNGEST_BASE_URL: devUrl,
    INNGEST_EXPERIMENTAL_KV_URL: redisUrl,
  });

  const appUrl = `http://127.0.0.1:${appPort}/api/inngest`;

  // The app syncs itself to the Dev Server when it is sent a PUT.
  await waitFor("the app", async () => {
    return (await get(appUrl, { method: "PUT" })).ok;
  });
  await waitFor("the synced functions", async () => {
    const dev = (await (await get(`${devUrl}/dev`)).json()) as {
      functions?: unknown[];
    };

    return (dev.functions?.length ?? 0) > 0;
  });

  return { name: options.name, devUrl, redisUrl };
};

/**
 * Stops every child with SIGTERM to its process group, then SIGKILL for any
 * that is still there after 3s.
 */
export const stopStack = async () => {
  const signal = (entry: Started, sig: NodeJS.Signals) => {
    try {
      if (entry.child.pid) {
        process.kill(-entry.child.pid, sig);
      }
    } catch {}
  };

  for (const entry of started) {
    signal(entry, "SIGTERM");
  }

  const end = Date.now() + 3_000;

  while (Date.now() < end && started.some((e) => !e.exited)) {
    await sleep(100);
  }

  for (const entry of started) {
    if (!entry.exited) {
      signal(entry, "SIGKILL");
    }
  }

  started.length = 0;
};
