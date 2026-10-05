/**
 * Putting the repository on a job's machine: `checkout()`, and the local
 * working-tree upload (a small tar writer) used when a run came from a local
 * fixture.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CiUsageError } from "../errors.ts";

import { ensureMachine } from "../machine/machine.ts";
import {
  defaultCwd,
  requireJobScope,
  scopeSeparator,
} from "../pipeline/scope.ts";

const exec = promisify(execFile);

/** Uploads are limited to 100 MiB, so a local checkout has an upper bound. */
export const maxUploadBytes = 100 * 1024 * 1024;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Put the repository on the job's machine, at `/work`.
 *
 * This is usually a job's first command, and it's what creates the machine.
 *
 * ```ts
 * const test = ci.job("test", async () => {
 *   await checkout();        // the machine starts here
 *   await $`pnpm install`;
 *   await $`pnpm test`;
 * });
 * ```
 *
 * Locally, it uploads your working tree, including uncommitted changes, so
 * there's nothing to push before running a pipeline. Against GitHub, it clones
 * the commit that triggered the run with a short-lived installation token that
 * never leaves the step handler — so it's never in step input, step output, or
 * the trace.
 *
 * @param opts.ref - The commit or ref to check out. Defaults to the run's.
 * @param opts.submodules - Also initialise submodules, recursively.
 * @param opts.history - `"full"` clones every blob. Defaults to `"shallow"`,
 * which filters them until they're needed.
 * @param opts.path - Where to put it. Defaults to `/work`, which is also the
 * default working directory for the job's commands.
 * @throws {CiUsageError} When called outside a job, or when the run has no
 * repository to check out.
 */
export const checkout = async (
  opts: {
    ref?: string;
    submodules?: boolean;
    history?: "shallow" | "full";
    path?: string;
  } = {},
): Promise<void> => {
  const scope = requireJobScope("checkout");
  const run = scope.run;
  const repo = run.repo;
  const target = opts.path ?? defaultCwd;

  const machine = await ensureMachine(scope);
  const stepId = `${scope.path}${scopeSeparator}checkout`;

  const useLocal =
    repo?.local && process.env.INNGEST_CI_GITHUB !== "live" ? repo.local : null;

  if (useLocal) {
    await run.step.run({ id: stepId, name: stepId }, async () => {
      const tarball = await buildWorkingTreeTarball(useLocal.path);

      if (tarball.byteLength > maxUploadBytes) {
        throw new CiUsageError(
          `The working tree is ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. Trim it, or use a GitHub checkout.`,
        );
      }

      const sandbox = await run.ci.client.sandboxes.get(machine.id);
      if (!sandbox) {
        throw new Error(`Machine ${machine.id} is gone`);
      }

      await sandbox.commands.run(["/bin/mkdir", "-p", target]);
      await sandbox.files.upload({
        path: `${target}/.inngest-ci-source.tar`,
        data: new Blob([new Uint8Array(tarball)]),
      });
      await sandbox.commands.run(
        ["/bin/tar", "-xf", ".inngest-ci-source.tar"],
        { cwd: target },
      );
      await sandbox.commands.run(["/bin/rm", "-f", ".inngest-ci-source.tar"], {
        cwd: target,
      });

      return { path: target, source: "local" as const };
    });

    scope.cwd ??= target;
    return;
  }

  if (!repo) {
    throw new CiUsageError(
      "`checkout()` needs a repository. This run's trigger doesn't have one, so set `repo: \"owner/name\"` on the pipeline or send an event with repository data.",
    );
  }

  await run.step.run({ id: stepId, name: stepId }, async () => {
    // The token is minted here, inside the handler, so it's never part of the
    // step's input or output. Both of those show in the trace.
    const { token } = await import("../github/helpers.ts");
    const accessToken = await token();

    const sandbox = await run.ci.client.sandboxes.get(machine.id);
    if (!sandbox) {
      throw new Error(`Machine ${machine.id} is gone`);
    }

    const sha = opts.ref ?? repo.sha;
    const url = `https://x-access-token:${accessToken}@github.com/${repo.fullName}.git`;
    const depth = opts.history === "full" ? [] : ["--filter=blob:none"];

    const script = [
      `git clone ${depth.join(" ")} --no-checkout "$CI_REPO_URL" ${target}`,
      `git -C ${target} checkout ${sha}`,
      ...(opts.submodules
        ? [`git -C ${target} submodule update --init --recursive`]
        : []),
    ].join(" && ");

    const result = await sandbox.commands.run(["/bin/sh", "-c", script], {
      environment: { CI_REPO_URL: url },
    });

    if (result.exitCode !== 0) {
      // The URL carries the token, so only the sanitised output is returned.
      throw new Error(
        `checkout failed with ${result.exitCode}: ${result.stderr.split(url).join("<redacted>")}`,
      );
    }

    return { sha, path: target, source: "github" as const };
  });

  scope.cwd ??= target;
};

/**
 * List the files git would consider part of the working tree: tracked files
 * plus untracked ones that aren't ignored.
 */
export const workingTreeFiles = async (cwd: string): Promise<string[]> => {
  const { stdout } = await exec(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  );

  return stdout.split("\0").filter(Boolean);
};

/**
 * Paths changed locally against a base ref, including untracked files. This is
 * what `changed()` uses when a run came from a local fixture.
 */
export const localChangedFiles = async (
  cwd: string,
  baseRef: string,
): Promise<string[]> => {
  const diffTargets = [`origin/${baseRef}`, baseRef, "HEAD"];
  let tracked: string[] = [];

  for (const target of diffTargets) {
    try {
      const { stdout } = await exec(
        "git",
        ["diff", "--name-only", `${target}...HEAD`],
        { cwd },
      );
      tracked = stdout.split("\n").filter(Boolean);
      break;
    } catch {
      // Try the next candidate; a fresh clone may have no origin.
    }
  }

  const { stdout: dirty } = await exec("git", ["status", "--porcelain"], {
    cwd,
  });

  const uncommitted = dirty
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    // Renames read as "old -> new"; the new path is the interesting one.
    .map((path) => path.split(" -> ").pop() as string);

  return [...new Set([...tracked, ...uncommitted])];
};

const blockSize = 512;

const octal = (value: number, length: number): string =>
  `${value.toString(8).padStart(length - 1, "0")}\0`;

/**
 * Build an uncompressed tar of the working tree.
 *
 * This is a small ustar writer rather than a dependency: the machine has
 * `tar`, the format is a few fixed-width fields, and CI only ever writes
 * regular files.
 */
export const buildWorkingTreeTarball = async (
  cwd: string,
): Promise<Uint8Array> => {
  const files = await workingTreeFiles(cwd);
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const relative of files) {
    const absolute = join(cwd, relative);

    let contents: Uint8Array;
    let mode = 0o644;

    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        continue;
      }
      mode = info.mode & 0o777;
      contents = new Uint8Array(await readFile(absolute));
    } catch {
      // Deleted between listing and reading.
      continue;
    }

    const header = new Uint8Array(blockSize);
    const write = (text: string, offset: number, length: number) => {
      const bytes = encoder.encode(text).slice(0, length);
      header.set(bytes, offset);
    };

    // ustar splits long names across `prefix` and `name`.
    const name = relative.length > 100 ? relative.slice(-100) : relative;

    write(name, 0, 100);
    write(octal(mode, 8), 100, 8);
    write(octal(0, 8), 108, 8);
    write(octal(0, 8), 116, 8);
    write(octal(contents.byteLength, 12), 124, 12);
    write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    write("        ", 148, 8); // checksum placeholder
    write("0", 156, 1);
    write("ustar\0", 257, 6);
    write("00", 263, 2);

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    write(octal(checksum, 7), 148, 7);
    header[155] = 0x20;

    blocks.push(header);
    blocks.push(contents);

    const padding = (blockSize - (contents.byteLength % blockSize)) % blockSize;
    if (padding > 0) {
      blocks.push(new Uint8Array(padding));
    }
  }

  // Two empty blocks end the archive.
  blocks.push(new Uint8Array(blockSize * 2));

  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tarball = new Uint8Array(total);
  let offset = 0;

  for (const block of blocks) {
    tarball.set(block, offset);
    offset += block.byteLength;
  }

  return tarball;
};
