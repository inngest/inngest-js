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
   * The most a bundle may weigh. A bundle moves through memoized steps, so it
   * can't exceed about 2 MiB. Default 1 MiB.
   */
  maxBytes?: number;
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
    options.maxBytes !== undefined &&
    (!Number.isInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 1536 * 1024)
  ) {
    throw new SandboxValidationError(
      "maxBytes must be a whole number from 1 to 1572864 (1.5 MiB), since a bundle moves through a memoized step",
    );
  }
};

const describe = (pushed: PushedRef): Record<string, unknown> => {
  return {
    ref: pushed.ref,
    sha: pushed.sha,
    ...(pushed.oldSha !== undefined && { previous: pushed.oldSha }),
  };
};

/**
 * EXPERIMENTAL: Builds the `git_push` tool for the sandbox behind `sandbox`.
 * Most code uses `sandbox.tools.git()` instead, which does this for the
 * sandbox it is defined on.
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

  const { cwd = "/work", maxBytes = defaultMaxBytes } = options;
  const { remote } = options;

  return tool({
    id: "git_push",
    group: true,
    description: `Pushes a branch of the repository in the sandbox to ${normalizeUrl(remote)}. The push is checked first and may be refused. It never forces and never deletes.`,
    input: z.object({
      branch: z
        .string()
        .describe("The local branch to push, such as agent/fix-typo"),
    }),
    run: async ({ branch }, { idempotencyKey, signal }) => {
      const ref = `refs/heads/${branch}`;

      if (!isPushableRef(ref)) {
        return agent.toolError(
          `${branch} is not a branch name git_push can push`,
        );
      }

      await assertHostGit();

      const path = `/tmp/inngest-git-${hashjs.sha256().update(idempotencyKey).digest("hex").slice(0, 16)}.bundle`;

      try {
        const bundled = await sandbox.commands.run(
          "git-push:bundle",
          [
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
          return agent.toolError(
            bundled.exitCode === 3
              ? `${branch} is not a branch in this repository`
              : `could not bundle ${branch}: ${bundled.stderr.trim().slice(0, 300)}`,
          );
        }

        const size = Number(bundled.stdout.trim());

        if (!(size <= maxBytes)) {
          return agent.toolError(
            `the push is ${size} bytes, more than the ${maxBytes} git_push accepts`,
          );
        }

        const bundle = await sandbox.files.read("git-push:read", path);

        if (bundle.byteLength > maxBytes) {
          return agent.toolError(
            `the push is more than the ${maxBytes} bytes git_push accepts`,
          );
        }

        const outcome = await step.run("git-push:push", async () => {
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
          return agent.toolError(`refused: ${outcome.refused}`);
        }

        if ("failed" in outcome) {
          return agent.toolError(
            `the remote rejected the push: ${outcome.failed}`,
          );
        }

        const [result] = outcome.pushed;

        if (!result || result.status === "non-fast-forward") {
          return agent.toolError(
            `${branch} is behind the remote branch, which has commits this repository lacks, so it can't be pushed as is`,
          );
        }

        return { pushed: outcome.pushed.map(describe) };
      } finally {
        await sandbox.commands.run("git-push:cleanup", ["rm", "-f", path], {
          cwd,
        });
      }
    },
  });
};
