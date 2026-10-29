/**
 * @module
 * EXPERIMENTAL: The `git_push` agent tool. The model asks to push a branch;
 * the branch is bundled inside the sandbox, the bundle comes home, and your
 * policy checks what it would really change before the function pushes it with
 * a token that exists nowhere else. The sandbox holds no credential, so there
 * is nothing for a model with a shell to print or copy.
 *
 * The checks and the push itself are `pushBundle()` in `sandbox/gitPush.ts`.
 */
import hashjs from "hash.js";
import { z } from "zod/v4";
import { step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import {
  isApiRemote,
  isGitHubRemote,
  manifestScript,
  pushManifest,
  remoteState,
} from "../sandbox/gitApi.ts";
import {
  assertHostGit,
  type GitPolicy,
  gitAuth,
  isPushableRef,
  normalizeUrl,
  type PushedRef,
  pushBundle,
} from "../sandbox/gitPush.ts";
import { type AgentTool, tool } from "../sandbox/tools.ts";
import {
  type SandboxHandle,
  SandboxValidationError,
} from "../sandbox/types.ts";
import { agent } from "./loop.ts";

const defaultMaxBytes = 1024 * 1024;

/**
 * Without git the manifest is read in pieces of this size, each in a step of
 * its own, so a push can be far bigger than one step's output.
 */
const manifestChunkBytes = 512 * 1024;
const defaultMaxApiBytes = 4 * 1024 * 1024;
const maxApiBytes = 8 * 1024 * 1024;
const maxBundleBytes = 1536 * 1024;

/**
 * Options of `gitPushTool()` and `sandbox.tools.git()`: where to push, with
 * what credentials, and which pushes to allow.
 */
export interface GitPushToolOptions {
  /**
   * The repository, as the host reaches it: an http(s) URL with no user name
   * or password.
   */
  remote: string;

  /**
   * Makes the token for one push. Called inside the push step on the host,
   * and never sent to the sandbox.
   */
  token: () => string | Promise<string>;

  /**
   * The user name that goes with the token. Defaults to `x-access-token`.
   */
  username?: string;

  /**
   * Decides each push before it happens. Without one every push of a new or
   * fast-forward branch is allowed, so name branches here.
   */
  policy?: GitPolicy;

  /**
   * The repository's directory in the sandbox. Default `/work`.
   */
  cwd?: string;

  /**
   * The most a push may weigh. With the host's git it is a bundle, which moves
   * through one memoized step, so it can't exceed 1.5 MiB (default 1 MiB).
   * Without git it is a manifest with the new files in base64, read in
   * pieces: up to 8 MiB (default 4 MiB), so files of a few MiB can be pushed.
   */
  maxBytes?: number;

  /**
   * How the push reaches the remote. `"git"` runs the host's `git` and
   * works with any remote. `"api"` needs no `git` on the machine that runs
   * your app, so the agent can run on Cloudflare Workers or any runtime with
   * `fetch`: it rebuilds the commits on a GitHub remote with the Git Data API.
   * It needs a linear history on top of the remote's branch (no merge commits
   * and no submodule changes). Default `"auto"`: the host's `git` when it
   * runs, else the API for a remote on github.com (or any `https://host/owner/repo`
   * when `api` is given).
   */
  transport?: "auto" | "git" | "api";

  /**
   * The GitHub API's base URL, for `"api"`. Default `https://api.github.com`,
   * or `/api/v3` on the remote's host for GitHub Enterprise.
   */
  api?: string;

  /**
   * The `fetch` the API push uses. Default the global one.
   */
  fetch?: typeof fetch;
}

const validate = (options: GitPushToolOptions): void => {
  let url: URL | undefined;

  try {
    url = new URL(options.remote);
  } catch {}

  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new SandboxValidationError(
      "git_push needs an http(s) remote URL without a user name or password; give the token in token",
    );
  }

  if (typeof options.token !== "function") {
    throw new SandboxValidationError("git_push needs a token function");
  }

  if (options.policy !== undefined && typeof options.policy !== "function") {
    throw new SandboxValidationError("policy must be a function");
  }

  if (
    options.transport !== undefined &&
    !["auto", "git", "api"].includes(options.transport)
  ) {
    throw new SandboxValidationError(
      'transport must be "auto", "git" or "api"',
    );
  }

  if (options.transport === "api" && !isApiRemote(options.remote)) {
    throw new SandboxValidationError(
      'transport "api" needs a remote like https://github.com/owner/repo',
    );
  }

  if (
    options.maxBytes !== undefined &&
    (!Number.isInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes >
        (options.transport === "git" ? maxBundleBytes : maxApiBytes))
  ) {
    throw new SandboxValidationError(
      options.transport === "git"
        ? "maxBytes must be a whole number from 1 to 1572864 (1.5 MiB), since a bundle moves through a memoized step"
        : "maxBytes must be a whole number from 1 to 8388608 (8 MiB); with the host's git it is held to 1.5 MiB",
    );
  }
};

/**
 * Which way to push: the host's git when the option and the machine allow, else
 * the GitHub API.
 */
const chooseTransport = async (
  options: GitPushToolOptions,
): Promise<"git" | "api"> => {
  const wanted = options.transport ?? "auto";

  if (wanted === "api") {
    return "api";
  }

  try {
    await assertHostGit();

    return "git";
  } catch (error) {
    if (
      wanted === "auto" &&
      (isGitHubRemote(options.remote) ||
        (options.api !== undefined && isApiRemote(options.remote)))
    ) {
      return "api";
    }

    throw error;
  }
};

const describe = (
  pushed: PushedRef,
): {
  ref: string;
  sha: string;
  previous?: string;
  notes?: string[];
  sandboxSha?: string;
} => {
  return {
    ref: pushed.ref,
    sha: pushed.sha,
    ...(pushed.oldSha !== undefined && { previous: pushed.oldSha }),
    ...(pushed.notes && { notes: pushed.notes }),
    ...(pushed.sandboxSha !== undefined && { sandboxSha: pushed.sandboxSha }),
  };
};

/**
 * The outcome of `pushBranch()`: the refs it pushed, or why it did not.
 */
export type PushBranchResult =
  | {
      ok: true;

      /**
       * Set when the push was rebuilt without git and the remote's commit hashes
       * differ from the sandbox's.
       */
      warning?: string;
      pushed: {
        ref: string;
        sha: string;
        previous?: string;

        /**
         * What the policy returned in `notes`.
         */
        notes?: string[];
        sandboxSha?: string;
      }[];
    }
  | { ok: false; error: string };

const fail = (error: string): PushBranchResult => {
  return { ok: false, error };
};

/**
 * EXPERIMENTAL: Pushes `branch` of the repository in `sandbox` the way the
 * `git_push` tool does, and returns the result as a value. Call it from your
 * own code in a function run (a routine, a tool of your own, a test with a fake
 * sandbox and `fetch`) instead of casting the tool's `run`. A refusal, a
 * rejection by the remote and a branch that is behind come back as
 * `{ ok: false, error }`; only a broken setup throws.
 *
 * @example
 * ```ts
 * const result = await pushBranch(sandbox, { remote, token }, "agent/fix", {
 *   idempotencyKey: runId,
 * });
 * ```
 */
export const pushBranch = async (
  sandbox: SandboxHandle,
  options: GitPushToolOptions,
  branch: string,
  context: {
    /**
     * Names the files the push uses in the sandbox; keep it the same on a retry.
     */
    idempotencyKey: string;

    /**
     * Aborts the requests of the push.
     */
    signal?: AbortSignal;
  },
): Promise<PushBranchResult> => {
  validate(options);

  const { cwd = "/work" } = options;
  const { remote } = options;
  const { idempotencyKey, signal } = context;
  const ref = `refs/heads/${branch}`;

  if (!isPushableRef(ref)) {
    return fail(`${branch} is not a branch name git_push can push`);
  }

  // Decided once in a step, so a replay on another runtime keeps the first
  // run's choice.
  const transport = await step.run("git-push:transport", async () => {
    try {
      return await chooseTransport(options);
    } catch (error) {
      // No git on this machine does not change on a retry.
      throw new NonRetriableError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  });
  const path = `/tmp/inngest-git-${hashjs.sha256().update(idempotencyKey).digest("hex").slice(0, 16)}.${transport === "api" ? "manifest" : "bundle"}`;
  const remoteInfo =
    transport === "api"
      ? await step.run("git-push:remote", async () => {
          return remoteState({
            remote,
            ref,
            token: await options.token(),
            api: options.api,
            fetch: options.fetch,
            signal,
          });
        })
      : undefined;
  let tip = "";
  const maxBytes =
    options.maxBytes ?? (remoteInfo ? defaultMaxApiBytes : defaultMaxBytes);

  if (!remoteInfo && maxBytes > maxBundleBytes) {
    return fail(
      `maxBytes is ${maxBytes}, but a push through the host's git is held to ${maxBundleBytes} bytes`,
    );
  }

  try {
    const bundled = await sandbox.commands.run(
      "git-push:bundle",
      remoteInfo
        ? [
            "/bin/sh",
            "-c",
            `tip=$(git rev-parse --verify --quiet "$2^{commit}") || { echo "no such branch" >&2; exit 3; }
set -- "$1" "$tip" "$3"
${manifestScript}printf '%s\\n' "$tip"; wc -c < "$3"`,
            "sh",
            remoteInfo.base,
            ref,
            path,
          ]
        : [
            "/bin/sh",
            "-c",
            'git rev-parse --verify --quiet "$1^{commit}" >/dev/null || { echo "no such branch" >&2; exit 3; }; git bundle create --quiet "$2" "$1" && wc -c < "$2"',
            "sh",
            ref,
            path,
          ],
      { cwd },
    );

    if (bundled.exitCode !== 0) {
      return fail(
        bundled.exitCode === 3
          ? `${branch} is not a branch in this repository`
          : bundled.exitCode === 4
            ? remoteInfo && remoteInfo.oldSha === undefined
              ? `this repository doesn't have ${remoteInfo.base.slice(0, 10)}, the tip of the remote's default branch, so ${branch} can't be compared with it; fetch it or clone again`
              : `${branch} is behind the remote branch, which has commits this repository lacks, so it can't be pushed as is`
            : `could not bundle ${branch}: ${bundled.stderr.trim().slice(0, 300)}`,
      );
    }

    const printed = bundled.stdout.trim().split("\n");

    tip = remoteInfo ? (printed[0] ?? "") : "";

    const size = Number(printed.at(-1));

    if (!(size <= maxBytes)) {
      return fail(
        `the push is ${size} bytes, more than the ${maxBytes} git_push accepts`,
      );
    }

    let bundle: Uint8Array;

    if (remoteInfo && size > manifestChunkBytes) {
      // The manifest is plain text; each piece is a step of its own.
      const pieces: string[] = [];

      for (let at = 0; at * manifestChunkBytes < size; at += 1) {
        const piece = await sandbox.commands.run(
          `git-push:read:${at}`,
          [
            "/bin/sh",
            "-c",
            'tail -c +"$1" "$2" | head -c "$3"',
            "sh",
            String(at * manifestChunkBytes + 1),
            path,
            String(manifestChunkBytes),
          ],
          { cwd },
        );

        pieces.push(piece.stdout);
      }

      bundle = new TextEncoder().encode(pieces.join(""));
    } else {
      bundle = await sandbox.files.read("git-push:read", path);
    }

    if (bundle.byteLength !== size) {
      return fail(
        `the push could not be read in full from the sandbox (${bundle.byteLength} of ${size} bytes)`,
      );
    }

    if (bundle.byteLength > maxBytes) {
      return fail(
        `the push is more than the ${maxBytes} bytes git_push accepts`,
      );
    }

    const outcome = await step.run("git-push:push", async () => {
      if (remoteInfo) {
        return pushManifest({
          remote,
          token: await options.token(),
          api: options.api,
          fetch: options.fetch,
          manifest: new TextDecoder().decode(bundle),
          target: { src: ref, dst: ref },
          tip,
          state: remoteInfo,
          policy: options.policy,
          signal,
        });
      }

      return pushBundle({
        remote,
        auth: await gitAuth(options.token, options.username),
        bundle,
        targets: [{ src: ref, dst: ref }],
        policy: options.policy,
        signal,
      });
    });

    if ("refused" in outcome) {
      return fail(`refused: ${outcome.refused}`);
    }

    if ("failed" in outcome) {
      return fail(`the remote rejected the push: ${outcome.failed}`);
    }

    const [result] = outcome.pushed;

    if (!result || result.status === "non-fast-forward") {
      return fail(
        remoteInfo && remoteInfo.oldSha === undefined
          ? `${branch} doesn't continue from a commit of the remote's default branch (or it was created on the remote meanwhile), so a push without git can't create it; rebase it onto the default branch`
          : `${branch} is behind the remote branch, which has commits this repository lacks, so it can't be pushed as is`,
      );
    }

    const rebuilt = outcome.pushed.some((pushed) => {
      return pushed.sandboxSha !== undefined;
    });

    return {
      ok: true,
      pushed: outcome.pushed.map(describe),
      ...(rebuilt && {
        warning:
          "The remote's commits have different hashes than this repository's, so this branch does not contain them: clone again or fetch before the next push.",
      }),
    };
  } finally {
    await sandbox.commands.run("git-push:cleanup", ["rm", "-f", path], {
      cwd,
    });
  }
};

/**
 * EXPERIMENTAL: Builds the `git_push` tool for the sandbox behind `sandbox`.
 * Most code uses `sandbox.tools.git()` instead, which does this for the
 * sandbox it is defined on. To push from your own code, use `pushBranch()`.
 *
 * It pushes one branch, to the branch of the same name on `remote`. It never
 * forces, deletes, or pushes elsewhere. A refusal is an error result the model
 * can read and act on.
 */
export const gitPushTool = (
  sandbox: SandboxHandle,
  options: GitPushToolOptions,
): AgentTool => {
  validate(options);

  return tool({
    id: "git_push",
    group: true,
    description: `Pushes a branch of the repository in the sandbox to ${normalizeUrl(options.remote)}. The push is checked first and may be refused. It never forces and never deletes.`,
    input: z.object({
      branch: z
        .string()
        .describe("The local branch to push, such as agent/fix-typo"),
    }),
    run: async ({ branch }, context) => {
      const result = await pushBranch(sandbox, options, branch, context);

      return result.ok
        ? {
            pushed: result.pushed,
            ...(result.warning && { warning: result.warning }),
          }
        : agent.toolError(result.error);
    },
  });
};
