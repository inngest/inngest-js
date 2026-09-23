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
 * there's nothing to do before paying for one:
 *
 * ```ts
 * if (!(await changed("src/**", "package.json"))) {
 *   return ci.skip("nothing that affects the build changed");
 * }
 *
 * if (await changed({ include: ["docs/**"], ignore: ["docs/**\/*.png"] })) {
 *   await docsSite();
 * }
 * ```
 *
 * Patterns support `**`, `*`, `?`, and `{a,b}`. The changed files come from
 * the pull request or the push range on GitHub, and from git locally.
 *
 * When the change can't be read — no credentials, say — this answers `true`
 * and notes it on the check, so work runs rather than being skipped wrongly.
 *
 * @throws {CiUsageError} When called outside a pipeline run.
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

  // Without a way to read the change, the safe answer is "something might
  // have", so a pipeline runs rather than silently skipping.
  if (files === null) {
    return true;
  }

  return filterPaths(files, opts).length > 0;
}

/**
 * The paths changed by whatever triggered this run, or `null` when they can't
 * be read — a cron with no repository, or a run with no GitHub credentials.
 */
export const changedFiles = async (): Promise<string[] | null> => {
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

  const files = (await run.step.run({ id, name: id }, async () => {
    try {
      return await listChangedFiles(run.repo);
    } catch (error) {
      if (!(error instanceof CiUsageError)) {
        throw error;
      }

      // No credentials, so the change can't be read. The caller assumes
      // everything changed rather than skipping work it shouldn't.
      return { unknown: true as const, reason: error.message };
    }
  })) as string[] | { unknown: true; reason: string };

  if (!Array.isArray(files)) {
    run.warnings.push(
      `\`changed()\` assumed everything changed: ${files.reason}`,
    );
    return null;
  }

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
    const files = await paginate(rest.pulls.listFiles, {
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
 * matched file's contents change, so a job is reused until its inputs move.
 *
 * ```ts
 * cache: { key: files("pnpm-lock.yaml", ".nvmrc") }
 * cache: { key: files("migrations/**", "seeds/**") }
 * cache: { key: [files("go.mod", "go.sum"), "go1.25"] }
 * ```
 *
 * Contents are read from the git tree for the run's commit, or from the
 * working tree locally, so uncommitted changes change the key too.
 *
 * @param patterns - Glob patterns, supporting `**`, `*`, `?`, and `{a,b}`.
 */
export const files = (...patterns: string[]): CacheKeyPart => ({
  kind: "inngest/ci.cacheKeyPart",
  type: "files",
  patterns,
});

/**
 * How much longer the command running a wait loop is given than the loop
 * itself, so the loop's own deadline decides and its failure is the one seen.
 */
const waitHeadroomMs = 15_000;

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
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Wait for a URL on the machine to answer, instead of sleeping and hoping.
 *
 * The retry loop runs on the machine rather than from your app, so it's one
 * step however long it takes, and the URL is one the machine can reach —
 * usually `127.0.0.1`.
 *
 * ```ts
 * await $`pnpm start`.background();
 * await waitForHttp("http://127.0.0.1:3000/health");
 * ```
 *
 * @param url - The URL to request, from the machine's point of view.
 * @param opts.status - The status code to wait for. Defaults to 200.
 * @param opts.timeout - How long to keep trying. Defaults to `"2m"`.
 * @param scope - Internal: the machine to run on. `sandbox()` passes its own.
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
  ).timeout(`${timeoutMs + waitHeadroomMs}ms`);
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Wait for a port on the machine to accept connections.
 *
 * ```ts
 * await $`pnpm start`.background();
 * await waitForPort(3000);
 * ```
 *
 * Note: there are no port events yet, so this is a loop inside the machine
 * rather than a durable wait. It's still one step.
 *
 * @param port - The port to connect to on `127.0.0.1`.
 * @param opts.timeout - How long to keep trying. Defaults to `"2m"`.
 * @param scope - Internal: the machine to run on. `sandbox()` passes its own.
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
  ).timeout(`${timeoutMs + waitHeadroomMs}ms`);
};
