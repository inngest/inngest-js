/**
 * @module
 * EXPERIMENTAL: `repo()`, which checks a git repository out into a sandbox
 * (or brings the checkout a restored sandbox already holds up to date) and
 * pushes branches from it. The token is only in the environment of the one
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

  /**
   * What to do when `path` already holds a checkout, as in a sandbox restored
   * from a thread's snapshot or recycled mid-run. The repository is fetched
   * either way.
   *
   * - `"reset"` (default): the working copy becomes `ref` as the remote has it.
   *   Local commits on that branch, uncommitted changes and untracked files
   *   are discarded, as in a fresh clone; ignored files and submodules are
   *   left alone. A checkout of another repository is repointed at this one.
   * - `"keep"`: nothing the agent did is discarded. `ref` is checked out (a
   *   branch is fast-forwarded to the remote when it can be), uncommitted
   *   changes come along, and a branch that has local commits or diverged
   *   from the remote stays where it is, with a note on stderr. Commits that
   *   only a detached HEAD held move to a `detached-<sha>` branch. A checkout
   *   that would overwrite local changes, or one of another repository,
   *   fails.
   */
  sync?: "reset" | "keep";
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
   * Whether the repository was cloned into an empty `path` or the checkout
   * already there was fetched and brought to `ref`.
   */
  action: "cloned" | "synced";

  /**
   * The commit that is checked out.
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

// The token reaches git as configuration in the environment of the one git
// process that talks to the remote (`auth ...`, a wrapper of `git`), so it never appears in an
// argument, a URL, a config file or the remote, and no other git process of the
// script (nor a hook it runs) inherits it. A concurrent process of the same user
// in the sandbox could still read it from /proc while the command runs. `GIT_TOKEN` itself is dropped from the
// script's environment at once. Hooks and the file system monitor are off for
// every git command here, because the checkout is in a sandbox that the model
// can write to.
const prelude = `
HEADER=
if [ -n "$GIT_TOKEN" ]; then
  HEADER="Authorization: basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')"
fi
unset GIT_TOKEN
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
# Rewrite rules in the checkout could send a fetch or push (and the token) to
# another host, so they are removed before the token is used.
scrub() {
  g -C "$DIR" config --local --name-only --get-regexp '^url\\..*\\.(push)?insteadof$' 2>/dev/null |
    while read -r key; do g -C "$DIR" config --local --unset-all "$key"; done
}
auth() {
  if [ -n "$HEADER" ]; then
    env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader "GIT_CONFIG_VALUE_0=$HEADER" git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c http.proxy= "$@"
  else
    g "$@"
  fi
}
`;

// Clones into an empty path, or fetches into a checkout that is already there
// and brings it to the ref. The last line it prints is `repo:<action>:<sha>`.
const checkoutScript = `${prelude}
if [ -e "$DIR/.git" ]; then
  scrub
  have=$(g -C "$DIR" config --local --get remote.origin.url 2>/dev/null || true)
  if [ "$have" != "$URL" ]; then
    if [ "$SYNC" = keep ]; then
      printf '%s\n' "the checkout at $DIR is of \${have:-no remote}, not $URL, and keep does not repoint it" >&2
      exit 1
    fi
    if [ -n "$have" ]; then g -C "$DIR" remote set-url origin "$URL"; else g -C "$DIR" remote add origin "$URL"; fi || exit 1
  fi
  auth -C "$DIR" fetch --force --quiet --no-recurse-submodules --tags --prune origin || exit 1
  if [ -z "$REF" ]; then
    auth -C "$DIR" remote set-head origin --auto >/dev/null 2>&1
    REF=$(g -C "$DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|^origin/||')
    [ -n "$REF" ] || { printf '%s\n' "cannot find the default branch of origin" >&2; exit 1; }
  fi
  if [ "$SYNC" = keep ]; then
    # Commits that only a detached HEAD holds would be left behind: keep them.
    if ! g -C "$DIR" symbolic-ref -q HEAD >/dev/null && [ -n "$(g -C "$DIR" rev-list -n1 HEAD --not --branches --remotes 2>/dev/null)" ]; then
      g -C "$DIR" branch "detached-$(g -C "$DIR" rev-parse --short HEAD)" 2>/dev/null || true
    fi
    if g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      if g -C "$DIR" show-ref --verify --quiet "refs/heads/$REF"; then
        g -C "$DIR" checkout --quiet "$REF" || exit 1
      else
        g -C "$DIR" checkout --quiet -b "$REF" "origin/$REF" || exit 1
      fi
      g -C "$DIR" merge --quiet --ff-only "origin/$REF" >/dev/null 2>&1 ||
        printf '%s\n' "$REF was not fast-forwarded: it has local commits or changes in the way" >&2
    else
      g -C "$DIR" checkout --quiet --detach "$REF" || exit 1
    fi
  else
    rm -f "$DIR/.git/index.lock"
    g -C "$DIR" rebase --abort >/dev/null 2>&1
    g -C "$DIR" merge --abort >/dev/null 2>&1
    if g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      g -C "$DIR" checkout --quiet -f -B "$REF" "origin/$REF" || exit 1
    else
      g -C "$DIR" checkout --quiet -f --detach "$REF" || exit 1
    fi
    g -C "$DIR" clean --quiet -ffd || exit 1
  fi
  action=synced
else
  auth clone --quiet -- "$URL" "$DIR" &&
  g -C "$DIR" checkout --quiet "\${REF:-HEAD}" || exit 1
  action=cloned
fi
g -C "$DIR" config user.name "Coding agent" &&
g -C "$DIR" config user.email "agent@users.noreply.github.com" &&
printf 'repo:%s:%s\n' "$action" "$(g -C "$DIR" rev-parse HEAD)"
`;

const pushScript = `${prelude}
scrub
auth -C "$DIR" push --quiet -- "$URL" "refs/heads/$BRANCH:refs/heads/$BRANCH"
`;

/**
 * EXPERIMENTAL: Clones a repository into `sandbox` and returns a handle to push
 * branches from it. If `path` already holds a checkout, as in a sandbox
 * restored from a thread's snapshot, it is fetched and brought to `ref` instead
 * (see `sync`). The token stays out of the sandbox: it is only in the
 * environment of the clone, fetch and push commands. Git hooks are off for
 * these commands (the checkout is writable by the model, so a hook there could
 * read the token): a repository that relies on a `pre-push` hook, Git LFS for
 * one, does not get it.
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
  const { ref, path = "/work", sync = "reset" } = options;

  if (sync !== "reset" && sync !== "keep") {
    throw new NonRetriableError(
      `repo sync must be "reset" or "keep", not ${JSON.stringify(sync)}`,
    );
  }

  if (options.repo.startsWith("-")) {
    throw new NonRetriableError(`repo can't start with "-": ${options.repo}`);
  }

  if (ref?.startsWith("-")) {
    throw new NonRetriableError(`repo ref can't start with "-": ${ref}`);
  }

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

  const stdout = await git(
    "clone",
    `git clone or fetch ${options.repo}`,
    checkoutScript,
    { URL: url, REF: ref ?? "", SYNC: sync },
  );
  // The script's last line says what it did; anything before it is noise.
  const done = stdout
    .trim()
    .split("\n")
    .reverse()
    .map((line) => {
      return /^repo:(cloned|synced):([0-9a-f]+)$/.exec(line);
    })
    .find(Boolean);
  const action: "cloned" | "synced" =
    done?.[1] === "synced" ? "synced" : "cloned";
  const sha = done?.[2] ?? stdout.trim().split("\n").pop() ?? "";

  const push = async (branch: string): Promise<void> => {
    await git("push", `git push ${branch}`, pushScript, {
      BRANCH: branch,
      URL: url,
    });
  };

  return {
    path,
    action,
    sha,
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
