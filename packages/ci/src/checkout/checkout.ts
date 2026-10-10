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

  const local = localRepo(run);
  const stepId = `${scope.path}${scopeSeparator}checkout`;

  if (!local && !repo) {
    throw new CiUsageError(
      "`checkout()` needs a repository. This run's trigger doesn't have one, so set `repo: \"owner/name\"` on the pipeline or send an event with repository data.",
    );
  }

  if (local) {
    await checkoutLocal(scope, local.path, target, stepId);

    scope.cwd ??= target;

    return;
  }

  const machine = await ensureMachine(scope);

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

/** Refuse an upload past the limit, saying what was too big. */
const assertUploadSize = (
  tarball: Uint8Array,
  subject: string,
  trim: string,
): void => {
  if (tarball.byteLength > maxUploadBytes) {
    throw new CiUsageError(
      `${subject} ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. ${trim}, or use a GitHub checkout.`,
    );
  }
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
}

/** Past this many bytes of paths, removing files can't go in one command. */
const maxRemoveArgBytes = 64 * 1024;

/** What an upload strategy works from. */
interface Upload {
  scope: CiJobScope;
  machine: MachineHandle;
  localPath: string;
  target: string;
  /** The working tree's ID, when it has one. */
  treeId?: string;
  /** The tree the machine has, when known. */
  had?: string;
  /** Why the strategies before this one passed. */
  fallback?: string;
}

/** A strategy either did the upload, or passes (saying why, if it matters). */
interface Attempt {
  result?: Omit<LocalCheckoutResult, "path" | "source">;
  fallback?: string;
}

type Strategy = (upload: Upload) => Promise<Attempt>;

/** Tell the run's activity line what the checkout is doing. */
const announce = (upload: Upload, message: string): void => {
  const { scope } = upload;

  scope.run.ci.hooks.activity(scope.run, scope.jobPath, message);
};

const uploadUnchanged: Strategy = async (upload) => {
  if (!upload.treeId || upload.had !== upload.treeId) {
    return {};
  }

  announce(upload, "working tree unchanged");

  return {
    result: {
      mode: "unchanged",
      treeId: upload.treeId,
      files: 0,
      removed: 0,
      bytes: 0,
    },
  };
};

/**
 * Put the working tree on the machine: all of it, or just a `delta` from the
 * tree it has, in which case what's gone is removed first.
 *
 * The machine's tree is forgotten before anything changes on it, so a failure
 * part way never leaves a tree ID that isn't true.
 */
const transfer = async (
  upload: Upload,
  delta?: TreeDelta,
): Promise<Attempt["result"]> => {
  const { scope, machine, localPath, target, treeId } = upload;
  const changed = delta?.changed ?? [];
  const deleted = delta?.deleted ?? [];

  const tarball = delta
    ? await buildTarball(localPath, changed)
    : await buildWorkingTreeTarball(localPath);

  assertUploadSize(
    tarball,
    delta ? "The changes are" : "The working tree is",
    delta ? "Trim them" : "Trim it",
  );

  const size = formatBytes(tarball.byteLength);
  const gone = deleted.length > 0 ? ` · ${deleted.length} removed` : "";

  announce(
    upload,
    delta
      ? `uploading changes (${changed.length} ${changed.length === 1 ? "file" : "files"}, ${size}${gone})…`
      : `uploading working tree (${size})…`,
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

  if (!delta || changed.length > 0) {
    await sendTarball(sandbox, target, tarball);
  }

  return {
    mode: delta ? "delta" : "full",
    ...(treeId ? { treeId } : {}),
    ...(upload.fallback ? { fallback: upload.fallback } : {}),
    files: changed.length,
    removed: deleted.length,
    bytes: tarball.byteLength,
  };
};

/**
 * Nothing re-hashes the machine afterwards, since it has no git to do it
 * with: a delta is only as right as the diff and the machine's tree ID.
 */
const uploadDelta: Strategy = async (upload) => {
  const { localPath, treeId, had } = upload;

  if (!treeId) {
    return {};
  }

  if (!had) {
    return { fallback: "the machine has no known tree" };
  }

  const delta = await treeDelta(localPath, had, treeId);

  if (!delta) {
    return { fallback: "the machine's tree isn't known here" };
  }

  try {
    const removeBytes = delta.deleted.reduce((sum, path) => {
      return sum + path.length + 1;
    }, 0);

    if (removeBytes > maxRemoveArgBytes) {
      throw new Error(`${delta.deleted.length} files to remove`);
    }

    return { result: await transfer(upload, delta) };
  } catch (error) {
    // Part of the change may be on the machine now, so nothing is
    // assumed about it until the full upload has replaced it.
    upload.machine.treeId = undefined;

    return { fallback: `the changes wouldn't apply (${errorMessage(error)})` };
  }
};

const uploadFull: Strategy = async (upload) => {
  return { result: await transfer(upload) };
};

/**
 * The ways to get the working tree onto a machine, cheapest first. Each does
 * the upload or passes to the next, and the last one never passes.
 */
const strategies: Strategy[] = [uploadUnchanged, uploadDelta, uploadFull];

const uploadWorkingTree = async (
  base: Pick<Upload, "scope" | "machine" | "localPath" | "target">,
): Promise<LocalCheckoutResult> => {
  const upload: Upload = {
    ...base,
    treeId: await workingTreeId(base.localPath),
    had: base.machine.treeId,
  };

  for (const strategy of strategies) {
    const attempt = await strategy(upload);

    if (attempt.result) {
      return { path: upload.target, source: "local", ...attempt.result };
    }

    upload.fallback = attempt.fallback ?? upload.fallback;
  }

  throw new Error("No upload strategy took the working tree");
};

/**
 * `checkout()` of the local working tree. The machine may already have most
 * of it, from the snapshot it started from, so only what changed is uploaded.
 *
 * Layer snapshots (snapshot a large change once and let other jobs start from
 * it) were tried and removed: a snapshot takes ~16s to be ready whatever the
 * change size, while a delta of a typical edit uploads in ~2s. Revisit when
 * Sandboxes support cheap incremental snapshots.
 */
const checkoutLocal = async (
  scope: CiJobScope,
  localPath: string,
  target: string,
  stepId: string,
): Promise<void> => {
  const { run } = scope;
  const machine = await ensureMachine(scope);

  run.ci.hooks.activity(run, scope.jobPath, "checking working tree…");

  const result = await run.step.run({ id: stepId, name: stepId }, async () => {
    return uploadWorkingTree({ scope, machine, localPath, target });
  });

  machine.treeId = result.treeId;
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
