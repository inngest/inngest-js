/**
 * @module
 * EXPERIMENTAL: `repo()`, which checks a git repository out into a sandbox
 * and pushes branches from it. The token is only in the environment of the one
 * command that clones or pushes (redacted from traces), and never written to
 * git config or a file, so the model's own commands can't read it.
 */
import { z } from "zod/v4";

import { NonRetriableError } from "../NonRetriableError.ts";
import type { CodeToolName } from "../sandbox/codeTools.ts";
import { type SandboxTool, tool } from "../sandbox/tools.ts";
import type { DurableSandbox } from "../sandbox/types.ts";

/**
 * Options of `repo()`: which repository to check out and how.
 */
export interface RepoOptions {
  /**
   * A GitHub `owner/name`, or any git URL or path.
   */
  repo: string;

  /**
   * Branch, tag or commit to check out. Default is the repository's default
   * branch.
   */
  ref?: string;

  /**
   * Where to check out. Default `/work`.
   */
  path?: string;

  /**
   * Used to clone and push over HTTPS. Without it only public repositories
   * can be cloned.
   */
  token?: string | (() => string | Promise<string>);
}

/**
 * A repository checked out in a sandbox, made by `repo()`.
 */
export interface Repo {
  /**
   * Where the repository is checked out in the sandbox.
   */
  path: string;

  /**
   * The commit that was checked out.
   */
  sha: string;

  /**
   * Pushes a local branch to the remote under the same name.
   */
  push: (branch: string) => Promise<void>;

  /**
   * Everything a model needs to work on this repository, for `agent.loop()`:
   * the code tools (`read`, `write`, `edit`, `search`, `run`) working in
   * `path`, and `push`. `push` lets the model push a branch without ever
   * holding the token: the token is added to the command here.
   */
  tools: Record<CodeToolName | "push", SandboxTool>;
}

// The token reaches git as configuration in its environment, so it never
// appears in an argument, a URL, a config file or the remote.
const authenticate = `
if [ -n "$GIT_TOKEN" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader
  export GIT_CONFIG_VALUE_0="Authorization: basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')"
fi
`;

const cloneScript = `${authenticate}
git clone --quiet "$URL" "$DIR" &&
git -C "$DIR" checkout --quiet "\${REF:-HEAD}" &&
git -C "$DIR" config user.name "Coding agent" &&
git -C "$DIR" config user.email "agent@users.noreply.github.com" &&
git -C "$DIR" rev-parse HEAD
`;

const pushScript = `${authenticate}
git -C "$DIR" push --quiet origin "refs/heads/$BRANCH:refs/heads/$BRANCH"
`;

/**
 * EXPERIMENTAL: Clones a repository into `sandbox` and returns a handle to push
 * branches from it. The token stays out of the sandbox: it is only in the
 * environment of the clone and push commands.
 *
 * @example
 * ```ts
 * const checkout = await repo(sandbox, {
 *   repo: "acme/web",
 *   token: process.env.GITHUB_TOKEN,
 * });
 *
 * await agent.loop({
 *   model,
 *   prompt: `Fix the login bug in ${checkout.path}, then push a branch`,
 *   tools: checkout.tools,
 * });
 * ```
 */
export const repo = async (
  sandbox: Pick<DurableSandbox, "commands" | "tools">,
  options: RepoOptions,
): Promise<Repo> => {
  const { ref, path = "/work" } = options;
  const url = /^[\w.-]+\/[\w.-]+$/.test(options.repo)
    ? `https://github.com/${options.repo}.git`
    : options.repo;

  const git = async (
    id: string,
    name: string,
    script: string,
    environment: Record<string, string>,
  ): Promise<string> => {
    const token =
      typeof options.token === "function"
        ? await options.token()
        : options.token;
    const result = await sandbox.commands.run(
      { id, name },
      ["/bin/sh", "-c", script],
      { environment: { GIT_TOKEN: token ?? "", DIR: path, ...environment } },
    );

    if (result.exitCode !== 0) {
      throw new NonRetriableError(`${name} failed: ${result.stderr}`);
    }

    return result.stdout;
  };

  const stdout = await git("clone", `git clone ${options.repo}`, cloneScript, {
    URL: url,
    REF: ref ?? "",
  });

  const push = async (branch: string): Promise<void> => {
    await git("push", `git push ${branch}`, pushScript, { BRANCH: branch });
  };

  return {
    path,
    sha: stdout.trim().split("\n").pop() ?? "",
    push,
    tools: {
      ...sandbox.tools.code({ cwd: path }),
      push: tool.group({
        description: "Push a local branch to the remote under the same name.",
        input: z.object({ branch: z.string() }),
        run: async ({ branch }) => {
          await push(branch);

          return `pushed ${branch}`;
        },
      }),
    },
  };
};
