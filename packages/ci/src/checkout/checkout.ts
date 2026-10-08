/**
 * Putting the repository on a job's machine: `checkout()`, from a local
 * working tree or a GitHub clone.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import type { ResolvedSource } from "../github/source.ts";
import {
  resolveSource,
  sameRepo,
  targetsRunRepo,
  tokenForSource,
} from "../github/source.ts";
import { ensureMachine } from "../machine/machine.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { traceName } from "../pipeline/names.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  countApi,
  defaultCwd,
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
  /**
   * The repository to check out, as `owner/name`. Defaults to the run's. Needed
   * when the run's trigger has no repository.
   */
  repo?: string;
  /**
   * The branch, tag or commit to check out. Defaults to the run's commit, or to
   * the default branch when `repo` is another repository.
   */
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
 * Name another repository, a branch, a tag or a commit with `repo` and `ref`.
 * The ref is resolved to a commit once per run, so every job and every replay
 * checks out the same one. Without `repo`, `ref` overrides the run's commit. A
 * run whose trigger has no repository, like a cron, needs `repo`.
 *
 * ```ts
 * await checkout({ repo: "acme/platform" });                // default branch
 * await checkout({ repo: "acme/platform", ref: "v2.1.0" });
 * await checkout({ ref: "main" });                          // this repository
 * ```
 *
 * Don't pass a `repo` taken from untrusted event data: it picks what gets
 * cloned with your credentials.
 *
 * The GitHub App must be installed on the other repository's owner and have
 * access to it. The installation is found from the repository, so it doesn't
 * have to be the one that triggered the run.
 *
 * Locally, it uploads your working tree, including uncommitted changes, so
 * there's nothing to push before running a pipeline. Over an existing local
 * checkout it uploads only what changed since the machine's recorded tree and
 * removes the files deleted since. Only when that tree is unknown does it
 * extract everything on top, so files deleted since an earlier upload can
 * linger. With another `repo` or an explicit `ref` it clones from GitHub, as
 * CI does. Against GitHub, it clones the commit with a short-lived
 * installation token that never leaves the step handler, so it's never in step
 * input, step output, or the trace.
 *
 * @throws {CiUsageError} When called outside a job, or when neither the run
 * nor `repo` names a repository to check out.
 * @throws {NonRetriableError} When the GitHub App can't access the repository,
 * or the ref doesn't exist in it.
 */
export const checkout = async (opts: CheckoutOptions = {}): Promise<void> => {
  const scope = requireJobScope("checkout");

  countApi("checkout");
  const { run } = scope;
  const target = opts.path ?? defaultCwd;

  const local =
    run.repo?.local && process.env.INNGEST_CI_GITHUB !== "live"
      ? run.repo.local
      : null;

  if (local && targetsRunRepo(run, opts)) {
    await checkoutLocal(scope, local.path, target);

    scope.cwd ??= target;

    return;
  }

  if (!opts.repo && !run.repo) {
    throw new CiUsageError(
      '`checkout()` needs a repository. This run\'s trigger doesn\'t have one, so pass `checkout({ repo: "owner/name" })` or set `repo: "owner/name"` on the pipeline.',
    );
  }

  const source = await resolveSource(run, opts);
  const machine = await ensureMachine(scope);
  const stepId = `${scope.path}${scopeSeparator}checkout`;

  run.ci.hooks.activity(run, scope.jobPath, "cloning repository…");

  await ciRun(
    run,
    {
      step: { id: stepId, name: traceName.cloneRepository },
      intent: `Clone \`${source.fullName}\` into \`${target}\``,
    },
    async (note) => {
      const cloned = await cloneFromGithub(run, machine, source, opts, target);

      note.outcome({ path: target, sha: source.sha });

      return cloned;
    },
  );

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
}

/** Past this many bytes of paths, removing files can't go in one command. */
const maxRemoveArgBytes = 64 * 1024;

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
): Promise<void> => {
  const { run } = scope;
  const stepId = `${scope.path}${scopeSeparator}checkout`;
  const machine = await ensureMachine(scope);

  run.ci.hooks.activity(run, scope.jobPath, "checking working tree…");

  const result = (await run.step.run(
    { id: stepId, name: traceName.uploadWorkingTree },
    async () => {
      return uploadWorkingTree(scope, machine, localPath, target);
    },
  )) as LocalCheckoutResult;

  machine.treeId = result.treeId;
};

const uploadWorkingTree = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const treeId = await workingTreeId(localPath);
  const had = machine.treeId;

  if (treeId && had === treeId) {
    run.ci.hooks.activity(run, scope.jobPath, "working tree unchanged");

    return {
      path: target,
      source: "local",
      mode: "unchanged",
      treeId,
      files: 0,
      removed: 0,
      bytes: 0,
    };
  }

  let fallback: string | undefined;

  if (treeId && had) {
    const delta = await treeDelta(localPath, had, treeId);

    if (!delta) {
      fallback = "the machine's tree isn't known here";
    } else {
      try {
        return await uploadDelta(scope, machine, localPath, target, {
          delta,
          treeId,
        });
      } catch (error) {
        // Part of the change may be on the machine now, so nothing is
        // assumed about it until the full upload has replaced it.
        machine.treeId = undefined;

        fallback = `the changes wouldn't apply (${errorMessage(error)})`;
      }
    }
  } else if (treeId) {
    fallback = "the machine has no known tree";
  }

  return uploadFull(scope, machine, localPath, target, {
    ...(treeId ? { treeId } : {}),
    ...(fallback ? { fallback } : {}),
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

const uploadFull = async (
  scope: CiJobScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
  known: { treeId?: string; fallback?: string },
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const tarball = await buildWorkingTreeTarball(localPath);

  assertUploadSize(tarball, "The working tree is", "Trim it");

  run.ci.hooks.activity(
    run,
    scope.jobPath,
    `uploading working tree (${formatBytes(tarball.byteLength)})…`,
  );

  const sandbox = await getSandbox(run, machine);

  machine.treeId = undefined;

  await sendTarball(sandbox, target, tarball);

  return {
    path: target,
    source: "local",
    mode: "full",
    ...known,
    files: 0,
    removed: 0,
    bytes: tarball.byteLength,
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
  known: { delta: TreeDelta; treeId: string },
): Promise<LocalCheckoutResult> => {
  const { run } = scope;
  const { delta } = known;

  const removeBytes = delta.deleted.reduce((sum, path) => {
    return sum + path.length + 1;
  }, 0);

  if (removeBytes > maxRemoveArgBytes) {
    throw new Error(`${delta.deleted.length} files to remove`);
  }

  const tarball = await buildTarball(localPath, delta.changed);

  assertUploadSize(tarball, "The changes are", "Trim them");

  const removed =
    delta.deleted.length > 0 ? ` · ${delta.deleted.length} removed` : "";

  run.ci.hooks.activity(
    run,
    scope.jobPath,
    `uploading changes (${delta.changed.length} ${delta.changed.length === 1 ? "file" : "files"}, ${formatBytes(tarball.byteLength)}${removed})…`,
  );

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

  return {
    path: target,
    source: "local",
    mode: "delta",
    treeId: known.treeId,
    files: delta.changed.length,
    removed: delta.deleted.length,
    bytes: tarball.byteLength,
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
  repo: Pick<RepoContext, "pullRequest">;
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
  source: ResolvedSource,
  opts: CheckoutOptions,
  target: string,
) => {
  // The token is minted here, inside the step handler, so it's never part of
  // the step's input or output. Both of those show in the trace.
  const accessToken = await tokenForSource(run, source);

  const sandbox = await getSandbox(run, machine);

  const url = `https://x-access-token:${accessToken}@github.com/${source.fullName}.git`;

  // A fork's pull request head is only fetched for the run's own commit.
  const own =
    sameRepo(source.fullName, run.repo?.fullName) &&
    run.repo?.sha === source.sha;
  const pullRequest = own ? run.repo?.pullRequest : undefined;

  const script = cloneScript({
    repo: { ...(pullRequest ? { pullRequest } : {}) },
    opts,
    target,
    sha: source.sha,
  });

  const result = await sandbox.commands.run(["/bin/sh", "-c", script], {
    environment: { CI_REPO_URL: url },
  });

  if (result.exitCode !== 0) {
    // The URL carries the token, so only the sanitised output is returned.
    throw new Error(
      `checkout failed with ${result.exitCode}: ${result.stderr.split(url).join("<redacted>")}`,
    );
  }

  return { sha: source.sha, path: target, source: "github" as const };
};
