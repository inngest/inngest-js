/**
 * @module
 * EXPERIMENTAL: `repo()`, which checks a git repository out into a sandbox
 * and pushes branches from it. The token is only in the environment of the one
 * command that clones or pushes (redacted from traces), and never written to
 * git config or a file, so the model's own commands can't read it.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import type { DurableSandbox } from "../sandbox/types.ts";

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

export interface Repo {
  path: string;

  /**
   * The commit that was checked out.
   */
  sha: string;

  /**
   * Pushes a local branch to the remote under the same name.
   */
  push: (branch: string) => Promise<void>;
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
 * // ...the agent commits on a branch...
 * await checkout.push("fix/login");
 * ```
 */
export const repo = async (
  sandbox: DurableSandbox,
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

  return {
    path,
    sha: stdout.trim().split("\n").pop() ?? "",
    push: async (branch) => {
      await git("push", `git push ${branch}`, pushScript, { BRANCH: branch });
    },
  };
};
