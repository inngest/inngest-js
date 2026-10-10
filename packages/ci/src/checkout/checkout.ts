/**
 * Putting the repository on a job's machine: `checkout()`, from a local
 * working tree or a GitHub clone.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { ensureMachine } from "../machine/machine.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  countApi,
  defaultCwd,
  localRepo,
  requireJobScope,
  scopeSeparator,
} from "../pipeline/scope.ts";
import type { RepoContext } from "../types.ts";
import { errorMessage, formatBytes, shellEscape } from "../util.ts";
import { buildTarball, buildWorkingTreeTarball } from "./tarball.ts";
import type { TreeDelta } from "./tree.ts";
import { treeDelta, workingTreeId } from "./tree.ts";

/** Uploads are limited to 100 MiB, so a local checkout has an upper bound. */
const maxUploadBytes = 100 * 1024 * 1024;

interface CheckoutOptions {
  /** The commit or ref to check out. Defaults to the run's. */
  ref?: string;
  /** Also initialise submodules, recursively. */
  submodules?: boolean;
  /**
   * `"full"` clones every blob. Defaults to `"shallow"`, which filters them
   * until they're needed.
   */
  history?: "shallow" | "full";
  /**
   * Where to put it. Defaults to `/work`, which is also the default working
   * directory for the job's commands.
   */
  path?: string;
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Put the repository on the job's machine, at `/work`.
 *
 * This is usually a job's first command, and it's what creates the machine.
 *
 * If `/work` already has a checkout, it's updated to this run's commit instead
 * of cloned again, and installed dependencies and build output are kept. A job
 * that starts `from` a cached job should call `checkout()` again to move to
 * this run's commit, since the cached machine has the commit it was built on.
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
 * there's nothing to push before running a pipeline. Over an existing local
 * checkout it uploads only what changed since the machine's recorded tree and
 * removes the files deleted since. Only when that tree is unknown does it
 * extract everything on top, so files deleted since can linger. Against GitHub, it clones
 * the commit that triggered the run with a short-lived installation token that
 * never leaves the step handler, so it's never in step input, step output, or
 * the trace.
 *
 * @throws {CiUsageError} When called outside a job, or when the run has no
 * repository to check out.
 */
export const checkout = async (opts: CheckoutOptions = {}): Promise<void> => {
  const scope = requireJobScope("checkout");

  countApi("checkout");
  const { run } = scope;
  const repo = run.repo;
  const target = opts.path ?? defaultCwd;

  const local = localRepo(run);

  if (!local && !repo) {
    throw new CiUsageError(
      "`checkout()` needs a repository. This run's trigger doesn't have one, so set `repo: \"owner/name\"` on the pipeline or send an event with repository data.",
    );
  }

  const machine = await ensureMachine(scope);
  const stepId = `${scope.path}${scopeSeparator}checkout`;

  const result = await run.step.run({ id: stepId, name: stepId }, async () => {
    if (local) {
      return uploadWorkingTree(scope, machine, local.path, target);
    }

    return cloneFromGithub(run, machine, repo as RepoContext, opts, target);
  });

  if ("treeId" in result) {
    machine.treeId = result.treeId;
  }

  scope.cwd ??= target;
};

const getSandbox = async (run: CiRunScope, machine: MachineHandle) => {
  const sandbox = await run.ci.client.sandboxes.get(machine.id);

  if (!sandbox) {
    throw new Error(`Machine ${machine.id} is gone`);
  }

  return sandbox;
};

/** Refuse an upload past the limit, saying what was too big. */
const assertUploadSize = (tarball: Uint8Array, what: string): void => {
  if (tarball.byteLength > maxUploadBytes) {
    throw new CiUsageError(
      `${what} ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. Trim ${what.includes("changes") ? "them" : "it"}, or use a GitHub checkout.`,
    );
  }
};

/**
 * Upload a tar of the working tree, or of the files of a `delta` from the tree
 * the machine has, and unpack it. A delta removes what's gone first.
 *
 * The machine's tree ID is forgotten before anything changes on it, so a
 * failure part way never leaves one that isn't true.
 */
const transfer = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
  delta?: TreeDelta,
) => {
  const deleted = delta?.deleted ?? [];

  // Past this, removing files can't go in one command.
  if (deleted.join("\0").length > 64 * 1024) {
    throw new Error(`${deleted.length} files to remove`);
  }

  const tarball = delta
    ? await buildTarball(localPath, delta.changed)
    : await buildWorkingTreeTarball(localPath);

  assertUploadSize(tarball, delta ? "The changes are" : "The working tree is");

  scope.run.ci.hooks.activity(
    scope.run,
    scope.jobPath,
    `uploading ${delta ? "changes" : "working tree"} (${formatBytes(tarball.byteLength)})…`,
  );

  const sandbox = await getSandbox(scope.run, machine);

  machine.treeId = undefined;

  if (deleted.length > 0) {
    const removal = await sandbox.commands.run([
      "/bin/sh",
      "-c",
      'cd "$1" && shift && rm -f -- "$@"',
      "sh",
      target,
      ...deleted,
    ]);

    if (removal.exitCode !== 0) {
      throw new Error(`removing files exited with ${removal.exitCode}`);
    }
  }

  if (!delta || delta.changed.length > 0) {
    await sandbox.commands.run(["/bin/mkdir", "-p", target]);

    await sandbox.files.upload({
      path: `${target}/.inngest-ci-source.tar`,
      data: new Blob([new Uint8Array(tarball)]),
    });

    const unpacked = await sandbox.commands.run(
      ["/bin/tar", "-xf", ".inngest-ci-source.tar"],
      { cwd: target },
    );

    await sandbox.commands.run(["/bin/rm", "-f", ".inngest-ci-source.tar"], {
      cwd: target,
    });

    if (unpacked.exitCode !== 0) {
      throw new Error(`tar exited with ${unpacked.exitCode}`);
    }
  }

  return {
    files: delta?.changed.length ?? 0,
    removed: deleted.length,
    bytes: tarball.byteLength,
  };
};

/**
 * Put the working tree on the machine, uploading only what changed since the
 * tree it has when that's known. Nothing re-hashes the machine afterwards,
 * since it has no git to do it with, so a delta is only as right as the diff
 * and the machine's tree ID.
 */
const uploadWorkingTree = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
) => {
  const treeId = await workingTreeId(localPath);
  const had = machine.treeId;
  const base = { path: target, source: "local" as const, treeId };
  const none = { files: 0, removed: 0, bytes: 0 };

  if (treeId && treeId === had) {
    return { ...base, mode: "unchanged" as const, ...none };
  }

  let fallback: string | undefined;

  if (treeId && !had) {
    fallback = "the machine has no known tree";
  } else if (treeId && had) {
    const delta = await treeDelta(localPath, had, treeId);

    if (delta) {
      try {
        const sent = await transfer(scope, machine, localPath, target, delta);

        return { ...base, mode: "delta" as const, ...sent };
      } catch (error) {
        // Part of the change may be on the machine now, so nothing is
        // assumed about it until the full upload has replaced it.
        fallback = `the changes wouldn't apply (${errorMessage(error)})`;
      }
    } else {
      fallback = "the machine's tree isn't known here";
    }
  }

  const sent = await transfer(scope, machine, localPath, target);

  return {
    ...base,
    mode: "full" as const,
    ...(fallback ? { fallback } : {}),
    ...sent,
  };
};

/**
 * The shell script that clones the repository and checks out `sha`.
 *
 * The URL comes from `$CI_REPO_URL` so the token stays out of the script, and
 * the path and ref are quoted so they're only ever data. When the target is
 * already a git checkout it's updated to `sha` instead of cloned.
 */
export const cloneScript = (args: {
  repo: RepoContext;
  opts: CheckoutOptions;
  target: string;
  sha: string;
}): string => {
  const { repo, opts, sha } = args;

  // Quoting stops the shell reading a ref, but git would still read one
  // starting with `-` as an option.
  if (sha.startsWith("-")) {
    throw new CiUsageError(
      `\`checkout()\` was given the ref \`${sha}\`, which git would read as an option.`,
    );
  }
  const target = shellEscape(args.target);
  const filter = opts.history === "full" ? "" : "--filter=blob:none";

  // A fork's commits aren't in the target repository's branches, but GitHub
  // keeps every pull request's head under a ref there.
  const fork = repo.pullRequest?.fork
    ? `git -C ${target} fetch origin ${shellEscape(`refs/pull/${repo.pullRequest.number}/head`)}`
    : null;

  const submodules = opts.submodules
    ? [`git -C ${target} submodule update --init --recursive`]
    : [];

  const clone = [
    `git clone ${filter} --no-checkout -- "$CI_REPO_URL" ${target}`,
    ...(fork ? [fork] : []),
    `git -C ${target} checkout ${shellEscape(sha)}`,
    ...submodules,
  ].join(" && ");

  // A checkout that's already there, such as one restored from a cached
  // snapshot, moves to `sha`. The token in its old remote URL has expired, so
  // the remote is repointed. Nothing is cleaned, so installed dependencies and
  // build output stay.
  const update = [
    `git -C ${target} remote set-url origin "$CI_REPO_URL"`,
    fork ?? `git -C ${target} fetch ${filter} origin ${shellEscape(sha)}`,
    fork
      ? `git -C ${target} checkout --force --detach ${shellEscape(sha)}`
      : `git -C ${target} checkout --force --detach FETCH_HEAD`,
    ...submodules,
  ].join(" && ");

  return `if [ -d ${target}/.git ]; then ${update}; else ${clone}; fi`;
};

const cloneFromGithub = async (
  run: CiRunScope,
  machine: MachineHandle,
  repo: RepoContext,
  opts: CheckoutOptions,
  target: string,
) => {
  // The token is minted here, inside the step handler, so it's never part of
  // the step's input or output. Both of those show in the trace.
  const { token } = await import("../github/helpers.ts");
  const accessToken = await token();

  const sandbox = await getSandbox(run, machine);

  const sha = opts.ref ?? repo.sha;
  const url = `https://x-access-token:${accessToken}@github.com/${repo.fullName}.git`;
  const script = cloneScript({ repo, opts, target, sha });

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
};
