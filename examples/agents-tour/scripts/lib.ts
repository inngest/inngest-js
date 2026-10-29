/**
 * @module
 * Shared by the scripts: where things live, the pinned Dev Server build, and
 * the doctor that names whatever the machine is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const pinFile = join(root, ".devserver-pin");
export const ossRemote =
  process.env.TOUR_OSS_REMOTE ?? "https://github.com/inngest/inngest.git";

export const cacheRoot =
  process.env.TOUR_CACHE ??
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "inngest-agents-tour",
  );

export const readPin = () => {
  if (!existsSync(pinFile)) {
    throw new Error(`The pin file ${pinFile} is missing`);
  }

  return readFileSync(pinFile, "utf8").trim();
};

/**
 * Where the Dev Server binary of a commit is cached.
 */
export const binaryOf = (sha: string) => {
  return join(cacheRoot, "devserver", sha.slice(0, 12), "inngest-dev");
};

/**
 * The binary `pnpm tour` runs: `TOUR_DEVSERVER_BIN` (any Dev Server built
 * from the step-subscribe branch, such as a devstack build), else the cached
 * build of the pinned commit.
 */
export const resolveBinary = () => {
  const override = process.env.TOUR_DEVSERVER_BIN;

  if (override) {
    return existsSync(override) ? override : undefined;
  }

  const cached = binaryOf(readPin());

  return existsSync(cached) ? cached : undefined;
};

export const run = (cmd: string, args: string[], cwd = root) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });

  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
};

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

/**
 * Checks the tools the tour needs. `needGo` is for building the Dev Server.
 */
export const doctor = (options: { needGo: boolean }) => {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);

  checks.push({
    name: "Node 24 or newer",
    ok: major >= 24,
    detail: `found ${process.versions.node}`,
    fix: "Install Node 24 (https://nodejs.org) or switch with your version manager.",
  });

  const sdk = existsSync(join(root, "node_modules/inngest/package.json"));

  checks.push({
    name: "Dependencies installed",
    ok: sdk,
    detail: sdk
      ? "node_modules/inngest is linked"
      : "node_modules/inngest is missing",
    fix: "Run `pnpm install` in examples/agents-tour. If it then fails to link, build the SDK first: `pnpm install && pnpm --filter inngest build` at the repo root.",
  });

  const built = existsSync(join(root, "node_modules/inngest/index.js"));

  checks.push({
    name: "SDK built",
    ok: built,
    detail: built
      ? "packages/inngest/dist exists"
      : "packages/inngest/dist is empty",
    fix: "Run `pnpm install && pnpm --filter inngest build` at the repo root.",
  });

  if (options.needGo) {
    const go = run("go", ["version"]);

    checks.push({
      name: "Go (to build the Dev Server)",
      ok: go.ok,
      detail: go.ok ? go.out : "go was not found",
      fix: "Install Go from https://go.dev/dl (the build needs a recent version; it fetches its own toolchain if go.mod asks for a newer one).",
    });

    const git = run("git", ["--version"]);

    checks.push({
      name: "Git",
      ok: git.ok,
      detail: git.ok ? git.out : "git was not found",
      fix: "Install git.",
    });
  }

  const failed = checks.filter((check) => {
    return !check.ok;
  });

  for (const check of checks) {
    console.log(
      `${check.ok ? "ok     " : "MISSING"}  ${check.name}: ${check.detail}`,
    );
  }

  for (const check of failed) {
    console.error(`\n${check.name}: ${check.fix}`);
  }

  return failed.length === 0;
};

/**
 * A free TCP port on the loopback interface.
 */
export const freePort = () => {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        if (address && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("No port"));
        }
      });
    });
  });
};
