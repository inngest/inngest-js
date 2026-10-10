/**
 * Putting the repository on a job's machine: `checkout()`, from a local
 * working tree or a GitHub clone.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { ensureMachine } from "../machine/machine.ts";
import { ciStepOptions } from "../pipeline/metadata.ts";
import { steps } from "../pipeline/names.ts";
import type { CiRunScope, MachineHandle } from "../pipeline/scope.ts";
import {
  countApi,
  defaultCwd,
  joinId,
  requireJobScope,
} from "../pipeline/scope.ts";
import type { RepoContext } from "../types.ts";
import { shellEscape } from "../util.ts";
import { buildWorkingTreeTarball } from "./tarball.ts";

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
 * checkout the files are extracted on top, so files deleted locally since can
 * linger on the machine. Against GitHub, it clones
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

  const machine = await ensureMachine(scope);
  const stepId = joinId(scope.path, "checkout");

  const spec = local
    ? steps.uploadWorkingTree(stepId, target)
    : steps.cloneRepository(stepId, (repo as RepoContext).fullName, target);

  await run.step.run(ciStepOptions(spec), async () => {
    if (local) {
      return uploadWorkingTree(run, machine, local.path, target);
    }

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

const uploadWorkingTree = async (
  run: CiRunScope,
  machine: MachineHandle,
  localPath: string,
  target: string,
) => {
  const tarball = await buildWorkingTreeTarball(localPath);

  if (tarball.byteLength > maxUploadBytes) {
    throw new CiUsageError(
      `The working tree is ${Math.round(tarball.byteLength / 1024 / 1024)} MiB, and uploads are limited to 100 MiB. Trim it, or use a GitHub checkout.`,
    );
  }

  const sandbox = await getSandbox(run, machine);

  await sandbox.commands.run(["/bin/mkdir", "-p", target]);

  await sandbox.files.upload({
    path: `${target}/.inngest-ci-source.tar`,
    data: new Blob([new Uint8Array(tarball)]),
  });

  await sandbox.commands.run(["/bin/tar", "-xf", ".inngest-ci-source.tar"], {
    cwd: target,
  });

  await sandbox.commands.run(["/bin/rm", "-f", ".inngest-ci-source.tar"], {
    cwd: target,
  });

  return { path: target, source: "local" as const };
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
