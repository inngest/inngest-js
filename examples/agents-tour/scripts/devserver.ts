/**
 * @module
 * `pnpm tour:devserver`: builds the Dev Server the tour runs. Agents need a
 * Dev Server with `step.subscribe`, which the published CLI does not have yet,
 * so the tour pins an inngest/inngest commit in `.devserver-pin`, fetches it,
 * and builds it with Go. The binary is cached per commit, so a second run
 * does nothing.
 *
 * The Dev Server UI is not built (the tour has its own trace panel); a
 * placeholder page stands in for it. Set `TOUR_DEVSERVER_BIN` to use a binary
 * you already have, such as a `devstack build-local` result.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { binaryOf, cacheRoot, doctor, ossRemote, readPin } from "./lib.ts";

const sha = readPin();
const bin = binaryOf(sha);

if (process.env.TOUR_DEVSERVER_BIN) {
  console.log(`Using TOUR_DEVSERVER_BIN=${process.env.TOUR_DEVSERVER_BIN}`);
  process.exit(0);
}

if (existsSync(bin)) {
  console.log(`Dev Server ${sha.slice(0, 12)} is already built: ${bin}`);
  process.exit(0);
}

if (!doctor({ needGo: true })) {
  process.exit(1);
}

const step = (what: string, cmd: string, args: string[], cwd: string, env = {}) => {
  console.log(`\n[tour:devserver] ${what}`);

  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    console.error(`\n"${cmd} ${args.join(" ")}" failed (${result.status}).`);
    process.exit(1);
  }
};

const src = join(cacheRoot, "src", sha.slice(0, 12));

rmSync(src, { recursive: true, force: true });
mkdirSync(src, { recursive: true });

step("fetching inngest/inngest at the pinned commit", "git", ["init", "-q"], src);
step("adding the remote", "git", ["remote", "add", "origin", ossRemote], src);
step("fetching the commit (shallow)", "git", ["fetch", "--depth", "1", "origin", sha], src);
step("checking it out", "git", ["checkout", "-q", "--detach", "FETCH_HEAD"], src);

// The Go build embeds a UI directory and the docs; neither is needed here.
const stubs: [string, string][] = [
  [
    "pkg/devserver/static/index.html",
    "<!doctype html><title>Inngest Dev Server</title><p>The Agents Tour runs this Dev Server without its UI. Use the tour's Trace panel.</p>\n",
  ],
  ["internal/embeddocs/website/pages/docs/index.md", "# Inngest docs\n"],
];

for (const [path, content] of stubs) {
  const file = join(src, path);

  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

mkdirSync(dirname(bin), { recursive: true });

const tmp = `${bin}.tmp`;

step(
  "building the Dev Server with go (a few minutes the first time)",
  "go",
  ["build", "-trimpath", "-o", tmp, "./cmd"],
  src,
  { CGO_ENABLED: "0" },
);
renameSync(tmp, bin);
rmSync(src, { recursive: true, force: true });

console.log(`\nDev Server ${sha.slice(0, 12)} built: ${bin}`);
console.log("Next: pnpm tour");
