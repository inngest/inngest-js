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
  recordTiming,
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
 * that starts `from()` a cached job should call `checkout()` again to move to
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
 * extract everything on top, so files deleted since an earlier upload can
 * linger. Against GitHub, it clones
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

  const local =
    repo?.local && process.env.INNGEST_CI_GITHUB !== "live" ? repo.local : null;

  if (!local && !repo) {
    throw new CiUsageError(
      "`checkout()` needs a repository. This run's trigger doesn't have one, so set `repo: \"owner/name\"` on the pipeline or send an event with repository data.",
    );
  }

  if (local) {
    await checkoutLocal(scope, local.path, target);

    scope.cwd ??= target;

    return;
  }

  const machine = await ensureMachine(scope);
  const stepId = `${scope.path}${scopeSeparator}checkout`;

  run.ci.hooks.activity(run, scope.jobPath, "cloning repository…");

  await run.step.run({ id: stepId, name: stepId }, async () => {
    return cloneFromGithub(run, machine, repo as RepoContext, opts, target);
  });

  scope.cwd ??= target;
};

const getSandbox = async (run: CiRunScope, machine: MachineHandle) => {
  const sandbox = await run.ci.client.sandboxes.get(machine.id);

  if (!sandbox) {
    throw new Error(`Machine ${machine.id} is gone`);
  }

  return sandbox;
};

/** What a local `checkout()` did, as the step's output. */
interface LocalCheckoutResult {
  path: string;
  source: "local";
  /** `unchanged`: nothing to upload. `delta`: only what changed. `full`: everything. */
  mode: "unchanged" | "delta" | "full";
  /** The git tree ID the machine now has, when it could be worked out. */
  treeId?: string;
  /** Why a delta wasn't used, when it would have been. */
  fallback?: string;
  /** Files uploaded. */
  files: number;
  /** Files removed on the machine. */
  removed: number;
  /** Bytes of the uploaded tar. */
  bytes: number;
  /** Hashing the tree and diffing it. */
  hashMs: number;
  /** Building the tar. */
  tarMs: number;
  /** Uploading it and unpacking it. */
  uploadMs: number;
}

/** Past this many bytes of paths, removing files can't go in one command. */
const maxRemoveArgBytes = 64 * 1024;

/**
 * `checkout()` of the local working tree. The machine may already have most
 * of it, from the snapshot it started from, so only what changed is uploaded.
 *
 * We tried layer snapshots (upload a large change once, snapshot it, and let
 * the other jobs in the run start from that) and removed them. Measured on the
 * Dev Server with a 38 MB tree: a full upload took ~22s (~1.6 MB/s, limited by
 * upload bandwidth, so parallel uploads share it); a snapshot took ~16s to be
 * READY whatever the change size, because it captures the whole machine
 * (memory and disk); starting from one took ~1.4s; a delta of a typical edit
 * took ~2s. A layer only pays off when (jobs sharing the change - 1) x upload
 * time exceeds ~16s: many jobs, large changes or slow uplinks. Typical edits
 * are tiny deltas.
 *
 * Revisit when Sandboxes support cheap incremental snapshots, meaning a small
 * layer on top of an existing snapshot that is quick to create and to share.
 * Then snapshotting after `checkout()` (and similar automatic layers) would
 * speed up every job, and should be reconsidered.
 */
const checkoutLocal = async (
  scope: CiJobScope,
  localPath: string,
  target: string,
): Promise<void> => {
  const { run } = scope;
  const stepId = `${scope.path}${scopeSeparator}checkout`;
  const machine = await ensureMachine(scope);

  run.ci.hooks.activity(run, scope.jobPath, "checking working tree…");

  const result = (await run.step.run({ id: stepId, name: stepId }, async () => {
    return uploadWorkingTree(scope, machine, localPath, target);
  })) as LocalCheckoutResult;

  machine.treeId = result.treeId;

  if (result.mode !== "unchanged") {
    recordTiming(run, {
      kind: result.mode === "delta" ? "delta" : "upload",
      path: scope.path,
      durationMs: result.hashMs + result.tarMs + result.uploadMs,
      bytes: result.bytes,
    });
  }
};

const uploadWorkingTree = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const hashing = Date.now();
  const treeId = await workingTreeId(localPath);
  const had = machine.treeId;

  const base = { path: target, source: "local" as const };
  const none = { files: 0, removed: 0, bytes: 0, tarMs: 0, uploadMs: 0 };

  if (treeId && had === treeId) {
    run.ci.hooks.activity(run, scope.jobPath, "working tree unchanged");

    return {
      ...base,
      mode: "unchanged",
      treeId,
      ...none,
      hashMs: Date.now() - hashing,
    };
  }

  let fallback: string | undefined;

  if (treeId && had) {
    const delta = await treeDelta(localPath, had, treeId);
    const hashMs = Date.now() - hashing;

    if (!delta) {
      fallback = "the machine's tree isn't known here";
    } else {
      try {
        return await uploadDelta(scope, machine, localPath, target, {
          delta,
          treeId,
          hashMs,
        });
      } catch (error) {
        // Part of the change may be on the machine now, so nothing is
        // assumed about it until the full upload has replaced it.
        machine.treeId = undefined;

        fallback = `the changes wouldn't apply (${errorMessage(error)})`;

        run.logger?.debug?.({ fallback }, "uploading the whole working tree");
      }
    }
  } else if (treeId) {
    fallback = "the machine has no known tree";
  }

  return uploadFull(scope, machine, localPath, target, {
    ...(treeId ? { treeId } : {}),
    ...(fallback ? { fallback } : {}),
    hashMs: Date.now() - hashing,
  });
};

/** Put a tar in `target` and unpack it there. */
const sendTarball = async (
  sandbox: Awaited<ReturnType<typeof getSandbox>>,
  target: string,
  tarball: Uint8Array,
): Promise<void> => {
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
};

const uploadFull = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
  known: { treeId?: string; fallback?: string; hashMs: number },
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const building = Date.now();
  const tarball = await buildWorkingTreeTarball(localPath);
  const tarMs = Date.now() - building;

  if (tarball.byteLength > maxUploadBytes) {
    throw new CiUsageError(
      `The working tree is ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. Trim it, or use a GitHub checkout.`,
    );
  }

  run.ci.hooks.activity(
    run,
    scope.jobPath,
    `uploading working tree (${formatBytes(tarball.byteLength)})…`,
  );

  const uploading = Date.now();
  const sandbox = await getSandbox(run, machine);

  machine.treeId = undefined;

  await sendTarball(sandbox, target, tarball);

  machine.treeId = known.treeId;

  return {
    path: target,
    source: "local",
    mode: "full",
    ...(known.treeId ? { treeId: known.treeId } : {}),
    ...(known.fallback ? { fallback: known.fallback } : {}),
    files: 0,
    removed: 0,
    bytes: tarball.byteLength,
    hashMs: known.hashMs,
    tarMs,
    uploadMs: Date.now() - uploading,
  };
};

/**
 * Bring the machine from the tree it has to the one in the working tree:
 * remove what's gone, then unpack a tar of what was added or modified.
 *
 * Nothing re-hashes the machine afterwards, since it has no git to do it
 * with: the result is only as right as the diff and the machine's tree ID.
 */
const uploadDelta = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
  known: { delta: TreeDelta; treeId: string; hashMs: number },
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const { delta } = known;

  const removeBytes = delta.deleted.reduce((sum, path) => {
    return sum + path.length + 1;
  }, 0);

  if (removeBytes > maxRemoveArgBytes) {
    throw new Error(`${delta.deleted.length} files to remove`);
  }

  const building = Date.now();
  const tarball = await buildTarball(localPath, delta.changed);
  const tarMs = Date.now() - building;

  if (tarball.byteLength > maxUploadBytes) {
    throw new CiUsageError(
      `The changes are ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. Trim them, or use a GitHub checkout.`,
    );
  }

  const removed =
    delta.deleted.length > 0 ? ` · ${delta.deleted.length} removed` : "";

  run.ci.hooks.activity(
    run,
    scope.jobPath,
    `uploading changes (${delta.changed.length} ${delta.changed.length === 1 ? "file" : "files"}, ${formatBytes(tarball.byteLength)}${removed})…`,
  );

  const uploading = Date.now();
  const sandbox = await getSandbox(run, machine);

  machine.treeId = undefined;

  if (delta.deleted.length > 0) {
    const removal = await sandbox.commands.run([
      "/bin/sh",
      "-c",
      'cd "$1" && shift && rm -f -- "$@"',
      "sh",
      target,
      ...delta.deleted,
    ]);

    if (removal.exitCode !== 0) {
      throw new Error(`removing files exited with ${removal.exitCode}`);
    }
  }

  if (delta.changed.length > 0) {
    await sendTarball(sandbox, target, tarball);
  }

  machine.treeId = known.treeId;

  return {
    path: target,
    source: "local",
    mode: "delta",
    treeId: known.treeId,
    files: delta.changed.length,
    removed: delta.deleted.length,
    bytes: tarball.byteLength,
    hashMs: known.hashMs,
    tarMs,
    uploadMs: Date.now() - uploading,
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
