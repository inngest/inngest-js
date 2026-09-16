import { createRawCommand, defaultCwd } from "./command.ts";
import { CiUsageError } from "./errors.ts";
import { ensureMachine } from "./machine.ts";
import type { CiJobScope } from "./scope.ts";
import { nextStepId, requireJobScope, scopeSeparator } from "./scope.ts";
import type { CacheKeyPart, Duration, RepoContext } from "./types.ts";
import { durationToMs, filterPaths } from "./util.ts";

/** Uploads are limited to 100 MiB, so a local checkout has an upper bound. */
export const maxUploadBytes = 100 * 1024 * 1024;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Put the repository on the job's machine.
 *
 * Locally, this uploads your working tree, including uncommitted changes, so
 * there's nothing to push before running a pipeline. Against GitHub, it clones
 * the commit that triggered the run with a short-lived installation token that
 * never leaves the step handler.
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
      const { buildWorkingTreeTarball } = await import("./localCheckout.ts");
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
        data: new Blob([tarball as unknown as BlobPart]),
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
    const { token } = await import("./github/helpers.ts");
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
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Whether any of the run's changed files match the given patterns.
 *
 * This runs in your app rather than on a machine, so a pipeline can decide
 * there's nothing to do before starting one.
 */
export function changed(...patterns: string[]): Promise<boolean>;
export function changed(opts: {
  include?: string[];
  ignore?: string[];
}): Promise<boolean>;
export async function changed(
  ...args: [{ include?: string[]; ignore?: string[] }] | string[]
): Promise<boolean> {
  const first = args[0];
  const opts =
    typeof first === "object" && first !== null
      ? first
      : { include: args as string[] };

  const files = await changedFiles();
  return filterPaths(files, opts).length > 0;
}

/**
 * The paths changed by whatever triggered this run.
 */
export const changedFiles = async (): Promise<string[]> => {
  const { getRunScope } = await import("./scope.ts");
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      "`changed()` was called outside a pipeline run. Call it from inside `ci.pipeline()`.",
    );
  }

  const cached = run.changedFiles;
  if (cached) {
    return cached;
  }

  const { getJobScope } = await import("./scope.ts");
  const scopePath = getJobScope()?.path;
  const id = nextStepId(run, scopePath, "changed");

  const files = (await run.step.run({ id, name: id }, () =>
    listChangedFiles(run.repo),
  )) as string[];

  run.changedFiles = files;
  return files;
};

const listChangedFiles = async (
  repo: RepoContext | undefined,
): Promise<string[]> => {
  if (!repo) {
    return [];
  }

  if (repo.local && process.env.INNGEST_CI_GITHUB !== "live") {
    const { localChangedFiles } = await import("./localCheckout.ts");
    return localChangedFiles(repo.local.path, repo.local.baseRef);
  }

  const { paginate } = await import("./github/helpers.ts");
  const { rest } = await import("./github/rest.ts");

  if (repo.pullRequest) {
    const files = await paginate<{ filename: string }>(rest.pulls.listFiles, {
      pull_number: repo.pullRequest.number,
      per_page: 100,
    });

    // Pull requests list at most 3000 files, which is also where this stops
    // being a useful signal.
    return files.slice(0, 3000).map((file) => file.filename);
  }

  if (repo.baseSha && repo.sha) {
    const comparison = await rest.repos.compareCommitsWithBasehead({
      basehead: `${repo.baseSha}...${repo.sha}`,
    });

    return (comparison.files ?? []).map((file) => file.filename);
  }

  return [];
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * A cache key part built from repository files. The key changes when any
 * matched file's contents change.
 */
export const files = (...patterns: string[]): CacheKeyPart => ({
  kind: "inngest/ci.cacheKeyPart",
  type: "files",
  patterns,
});

const waitScript = (check: string, timeoutMs: number) =>
  [
    `deadline=$(( $(date +%s) + ${Math.ceil(timeoutMs / 1000)} ))`,
    "while [ $(date +%s) -lt $deadline ]; do",
    `  if ${check}; then exit 0; fi`,
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n");

/**
 * Wait for a URL on the machine to answer.
 *
 * The retry loop runs on the machine rather than from your app, so it's one
 * step however long it takes.
 */
export const waitForHttp = async (
  url: string,
  opts: { timeout?: Duration; status?: number } = {},
  scope?: CiJobScope,
): Promise<void> => {
  const target = scope ?? requireJobScope("waitForHttp");
  const timeoutMs = durationToMs(opts.timeout ?? "2m");
  const expected = opts.status ?? 200;

  const script = waitScript(
    `[ "$(curl -s -o /dev/null -w '%{http_code}' ${url})" = "${expected}" ]`,
    timeoutMs,
  );

  await createRawCommand(
    () => target,
    ["/bin/sh", "-c", script],
    `waitForHttp ${url}`,
  ).timeout(opts.timeout ?? "2m");
};

/**
 * Wait for a port on the machine to accept connections.
 *
 * There are no port events yet, so this is an in-machine loop rather than a
 * durable wait.
 */
export const waitForPort = async (
  port: number,
  opts: { timeout?: Duration } = {},
  scope?: CiJobScope,
): Promise<void> => {
  const target = scope ?? requireJobScope("waitForPort");
  const timeoutMs = durationToMs(opts.timeout ?? "2m");

  const script = waitScript(
    `(command -v nc >/dev/null && nc -z 127.0.0.1 ${port}) || (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null`,
    timeoutMs,
  );

  await createRawCommand(
    () => target,
    ["/bin/sh", "-c", script],
    `waitForPort ${port}`,
  ).timeout(opts.timeout ?? "2m");
};
