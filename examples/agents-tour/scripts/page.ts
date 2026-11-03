/**
 * @module
 * `pnpm tour:page <page>`: starts the tour from this worktree on a free port
 * and prints the address of one page, for whoever is writing that page.
 *
 * `<page>` is the page's folder, as `01-agents/02-hello-agent` (a leading
 * `lessons/` is fine). Nothing is rebuilt: a worktree without the built SDK
 * or the repo's packages borrows them, by symlink, from another worktree of
 * this repo whose `packages/inngest` is the same tree and already built. The
 * Dev Server is the cached build `pnpm tour` uses. Every run picks its own
 * ports, so many can run at once; port 4730 is never used.
 *
 * Prints `Page ready: <url>` once the page serves. Ctrl-C stops it, and so
 * does `pnpm tour:page --stop` from the same worktree.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadLessons } from "../server/lessons.ts";
import { freePort, root } from "./lib.ts";

const repo = resolve(root, "../..");
const stateFile = join(root, ".tour-cache", "page.json");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });

  return result.status === 0 ? result.stdout.trim() : "";
};

const stop = () => {
  if (!existsSync(stateFile)) {
    console.log("No page tour is running from this worktree.");

    return;
  }

  const { pid } = JSON.parse(readFileSync(stateFile, "utf8")) as {
    pid: number;
  };

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopping the page tour (pid ${pid}).`);
  } catch {
    console.log("The page tour had already stopped.");
    rmSync(stateFile, { force: true });
  }
};

const builtAt = (dir: string) => {
  const dist = join(dir, "packages/inngest/dist");

  return existsSync(join(dist, "experimental/agents/index.js"))
    ? statSync(realpathSync(dist)).mtimeMs
    : 0;
};

// The other worktrees of this repo whose `packages/inngest` is the same tree
// as ours, with nothing changed in it and a build made after its last change,
// newest build first.
const twins = () => {
  const tree = git(repo, "rev-parse", "HEAD:packages/inngest");
  const list = git(repo, "worktree", "list", "--porcelain");

  return list
    .split("\n")
    .filter((line) => {
      return line.startsWith("worktree ");
    })
    .map((line) => {
      return line.slice("worktree ".length);
    })
    .filter((dir) => {
      return (
        resolve(dir) !== repo &&
        existsSync(dir) &&
        git(dir, "rev-parse", "HEAD:packages/inngest") === tree &&
        git(dir, "status", "--porcelain", "--", "packages/inngest") === "" &&
        builtAt(dir) >
          Number(
            git(dir, "log", "-1", "--format=%ct", "--", "packages/inngest"),
          ) *
            1000
      );
    })
    .sort((a, b) => {
      return builtAt(b) - builtAt(a);
    });
};

const borrow = (path: string, has: (dir: string) => boolean) => {
  const target = join(repo, path);

  if (existsSync(target)) {
    return true;
  }

  if (lstatSync(target, { throwIfNoEntry: false })) {
    rmSync(target, { force: true });
  }

  for (const dir of twins()) {
    const source = join(dir, path);

    if (existsSync(source) && has(source)) {
      symlinkSync(realpathSync(source), target);
      console.log(`linked   ${path} from ${dir}`);

      return true;
    }
  }

  return false;
};

const prepare = () => {
  const sdk = borrow("packages/inngest/dist", (dir) => {
    return existsSync(join(dir, "experimental/agents/index.js"));
  });

  if (!sdk) {
    console.error(
      "No built SDK for this tree: run `pnpm install && pnpm --filter inngest build` at the repo root once.",
    );
    process.exit(1);
  }

  if (!borrow("node_modules", (dir) => existsSync(join(dir, ".bin/biome")))) {
    console.error(
      "No repo packages (Biome formats on Run): run `pnpm install` at the repo root once.",
    );
    process.exit(1);
  }

  if (!existsSync(join(root, "node_modules/inngest"))) {
    const result = spawnSync(
      "pnpm",
      ["install", "--ignore-workspace", "--config.lockfile=false"],
      { cwd: root, stdio: "inherit" },
    );

    if (result.status !== 0) {
      process.exit(1);
    }
  }
};

const pageUrl = (arg: string) => {
  const folder = arg.replace(/^(\.\/)?(lessons\/)?/, "").replace(/\/$/, "");
  const lessons = join(root, "lessons");
  const page = loadLessons(lessons).pages.find((candidate) => {
    return candidate.dir === join(lessons, folder);
  });

  if (!page) {
    console.error(
      `No page at lessons/${folder}. Give its folder, as 01-agents/02-hello-agent.`,
    );
    process.exit(1);
  }

  return `/tour/${page.id}`;
};

const arg = process.argv[2];

if (arg === "--stop") {
  stop();
  process.exit(0);
}

if (!arg) {
  console.error("Usage: pnpm tour:page <page folder> | pnpm tour:page --stop");
  process.exit(1);
}

const path = pageUrl(arg);

prepare();

const port = await freePort();
const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", join(root, "scripts/tour.ts")],
  {
    cwd: root,
    env: { ...process.env, TOUR_PORT: String(port), TOUR_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();

  process.stdout.write(text);

  const match = /running at (http:\/\/\S+)/.exec(text);

  if (match) {
    const url = `${match[1]}${path}`;

    mkdirSync(join(root, ".tour-cache"), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, url }));
    console.log(`Page ready: ${url}`);
  }
});

const shutdown = () => {
  child.kill("SIGTERM");
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

child.on("exit", (code) => {
  rmSync(stateFile, { force: true });
  process.exit(code ?? 0);
});
