/**
 * @module
 * Thin wrapper over `devstack`: starts a Dev Server, a Redis proc and the kit
 * app in one named stack, and stops it again. Every start happens inside
 * `devstack with` (see `run.ts`), so a crash cannot leak a stack.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const devstackBin =
  process.env.DEVSTACK_BIN ??
  join(homedir(), "repo/inngest/devstack/bin/devstack");

export const ossRepo =
  process.env.AGENTS_VERIFY_OSS_REPO ?? join(homedir(), "repo/inngest/inngest");

const redisCommand =
  process.env.AGENTS_VERIFY_REDIS_CMD ??
  ', valkey-server --bind 127.0.0.1 --port $PORT --save "" --appendonly no';

/**
 * Runs `devstack` and returns what it printed. Rejects with its output when
 * it exits non-zero.
 */
export const devstack = (args: string[]) => {
  return new Promise<string>((resolve, reject) => {
    execFile(
      devstackBin,
      args,
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`devstack ${args.join(" ")} failed\n${stdout}${stderr}`),
          );

          return;
        }

        resolve(`${stdout}${stderr}`);
      },
    );
  });
};

/**
 * A stack name for the branch and the scenarios being run, readable in the
 * devstack list. It is the same for the same branch and scenarios, so a caller
 * that needs a stack of its own adds something unique.
 */
export const stackName = (branch: string, label: string) => {
  const slug = (text: string, max: number) => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, max)
      .replace(/-$/, "");
  };
  const hash = createHash("sha1")
    .update(`${branch}\n${label}`)
    .digest("hex")
    .slice(0, 8);

  return `verify-${slug(branch, 20)}-${slug(label, 12)}-${hash}`;
};

const urlOf = async (stack: string, name: string) => {
  const status = JSON.parse(await devstack(["status", "--json"])) as {
    instances: { stack?: string; name: string; url?: string }[];
  };
  const found = status.instances.find((instance) => {
    return instance.stack === stack && instance.name === name;
  });

  if (!found?.url) {
    throw new Error(`devstack lists no ${name} in stack ${stack}`);
  }

  return found.url;
};

export interface Stack {
  name: string;
  devUrl: string;
  redisUrl: string;

  /**
   * Kills the app process and starts it again with the same environment,
   * keeping the Dev Server and Redis, and returns once it serves and has
   * synced again.
   */
  restartApp: () => Promise<void>;
}

export interface StartOptions {
  name: string;

  /**
   * `published`, `local` or `local@<sha>`; see `devstack dev start --bin`.
   */
  bin: string;

  /**
   * The package directory the app runs from.
   */
  cwd: string;

  /**
   * The command that serves the app on `$PORT`.
   */
  appCommand: string;

  /**
   * What the app needs beyond the Dev Server and Redis URLs.
   */
  appEnv: Record<string, string>;
}

/**
 * Starts the Dev Server, then Redis, then the app (which gets
 * `INNGEST_EXPERIMENTAL_KV_URL`), and waits until the app is synced.
 */
export const startStack = async (options: StartOptions): Promise<Stack> => {
  const { name } = options;

  // A stack left under this name, which a random name makes very unlikely.
  await devstack(["stop", name]).catch(() => {
    return "";
  });

  await devstack(["dev", "start", "--stack", name, "--bin", options.bin]);

  const devUrl = await urlOf(name, name);

  await devstack([
    "proc",
    "start",
    "--stack",
    name,
    "--name",
    "redis",
    "--cwd",
    options.cwd,
    "--cmd",
    redisCommand,
  ]);

  const redisHttp = await urlOf(name, "redis");
  const redisUrl = redisHttp.replace(/^http/, "redis");
  const env = {
    ...options.appEnv,
    INNGEST_EXPERIMENTAL_KV_URL: redisUrl,
  };

  await devstack([
    "app",
    "start",
    "--stack",
    name,
    "--name",
    "app",
    "--cwd",
    options.cwd,
    "--cmd",
    options.appCommand,
    "--path",
    "/api/inngest",
    ...Object.entries(env).flatMap(([key, value]) => {
      return ["--env", `${key}=${value}`];
    }),
  ]);

  return {
    name,
    devUrl,
    redisUrl,
    restartApp: async () => {
      await devstack(["restart", `${name}/app`]);

      const appUrl = await urlOf(name, "app");
      const end = Date.now() + 60_000;

      // The app syncs itself to the Dev Server when it is sent a PUT.
      while (Date.now() < end) {
        const synced = await fetch(appUrl, {
          method: "PUT",
          signal: AbortSignal.timeout(5_000),
        })
          .then((response) => {
            return response.ok;
          })
          .catch(() => {
            return false;
          });

        if (synced) {
          return;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      }

      throw new Error("the app did not come back after a restart");
    },
  };
};

export const stopStack = async (name: string) => {
  await devstack(["stop", name]).catch(() => {
    return "";
  });
};
