/**
 * @module
 * EXPERIMENTAL: `repo()`, which checks a git repository out into a sandbox
 * (or brings the checkout a restored sandbox already holds up to date) and
 * pushes branches from it. The token is only in the environment of the one
 * git process that talks to the remote (redacted from traces), and never written to
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
   * A GitHub `owner/name`, or any git URL or path. Give a path in the same
   * (absolute) form every time: `keep` compares it with the remote the
   * checkout stored.
   */
  repo: string;

  /**
   * Branch, tag or commit to check out. Default is the repository's default
   * branch; `"HEAD"` means the same.
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
   * - not set (default): a checkout with nothing to lose is brought to `ref`.
   *   One with local work (uncommitted changes, untracked files, or commits
   *   the remote lacks) is never wiped silently: `repo()` throws and names
   *   `"keep"` and `"reset"`. Local-only tags, ignored files and files marked
   *   assume-unchanged do not count as work.
   * - `"reset"`: the working copy becomes `ref` as the remote has it.
   *   Local commits on that branch, uncommitted changes and untracked files
   *   are discarded, as in a fresh clone; ignored files and submodules are
   *   left alone. A checkout of another repository is repointed at this one.
   * - `"keep"`: nothing the agent did is discarded. `ref` is checked out (a
   *   branch is fast-forwarded to the remote when it can be), uncommitted
   *   changes come along, and a branch that has local commits or diverged
   *   from the remote stays where it is, which the result reports as
   *   `action: "diverged"` with the local `sha`. Commits that only a
   *   detached HEAD held move to a `detached-<sha>` branch. A branch of your
   *   own that the remote lacks (or has deleted) can be `ref`, and tags you made are not
   *   overwritten. A checkout that would overwrite local changes, or one of
   *   another repository, fails.
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
   * What `repo()` did: `"cloned"` into an empty `path`; `"synced"`, the
   * checkout already there was fetched and brought to `ref`; or
   * `"diverged"` (`sync: "keep"` only), the remote was fetched but the branch
   * could not be fast-forwarded because it has diverged from the remote or has
   * uncommitted changes the update would touch, so `sha` is the local commit.
   * A branch that is only ahead of the remote has nothing to fast-forward and is
   * `"synced"`.
   */
  action: "cloned" | "synced" | "diverged";

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
// process that talks to the remote (`auth ...`, a wrapper of `git`), so it never
// appears in an argument, a URL, a config file or the remote, and no other git
// process of the script (nor a hook it runs) inherits it. `GIT_TOKEN` is unset
// in the script at once, but it stays in /proc/<pid>/environ of the script's
// shell (the initial environment block), and the header is in that of the git
// process, while they run: a concurrent process of the same user in the sandbox
// could read it there.
//
// The checkout is in a sandbox that the model can write to, so nothing that
// holds the token reads its configuration: the process that talks to the remote
// runs in a throwaway bare repository (`T`), and objects move between it and
// the checkout with local commands that carry no token. A rewrite rule, a
// second URL, a proxy, a credential helper or an include in the checkout's
// config therefore cannot redirect or intercept the token. The user's own
// global git config is ignored for the process that holds it. Hooks and the file
// system monitor are off for every git command here.
const prelude = `
HEADER=
if [ -n "$GIT_TOKEN" ]; then
  HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 | tr -d '\\n')"
fi
unset GIT_TOKEN
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
auth() {
  if [ -n "$HEADER" ]; then
    ( export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="$HEADER"
      exec git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@" )
  else
    g "$@"
  fi
}
# A branch the remote has, a tag, or a commit. A branch the remote deleted can
# still exist locally, and must not stand in for it (a deleted tag does stay,
# since pruning tags would delete the agent's own).
known() {
  g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$1" ||
    g -C "$DIR" show-ref --verify --quiet "refs/tags/$1" ||
    printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{7,64}$'
}
# Work in the checkout that a reset would lose: changes, untracked files, or
# commits no remote-tracking branch has. A git error counts as work, so a
# checkout that cannot be read is never wiped.
dirty() {
  s=$(g -C "$DIR" status --porcelain --untracked-files=all 2>&1) || return 0
  [ -n "$s" ] && return 0
  if g -C "$DIR" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    u=$(g -C "$DIR" rev-list -n1 HEAD --not --remotes 2>&1) || return 0
    [ -n "$u" ] && return 0
  fi
  u=$(g -C "$DIR" rev-list -n1 --branches --not --remotes 2>&1) || return 0
  [ -n "$u" ]
}
T=$(mktemp -d) || exit 1
# A clone that fails part way leaves a checkout that looks like work: remove it.
CLONING=
# Only a directory this script is the one to fill: absent (removed whole) or empty
# (emptied), never one that already held files.
trap 'rc=$?; rm -rf "$T"; if [ "$rc" -ne 0 ]; then
  if [ "$CLONING" = new ]; then rm -rf -- "$DIR";
  elif [ "$CLONING" = empty ]; then find "$DIR/." -mindepth 1 -maxdepth 1 -exec rm -rf -- {} \\; ; fi
fi' EXIT
trap 'exit 1' HUP INT TERM
g init --quiet --bare "$T" || exit 1
`;

// Clones into an empty path, or fetches into a checkout that is already there
// and brings it to the ref. The last line it prints is `repo:<action>:<sha>`.
const checkoutScript = `${prelude}
if [ -e "$DIR/.git" ]; then
  if [ -z "$SYNC" ] && dirty; then
    printf '%s\\n' "the checkout at $DIR has work a sync would lose (changes, untracked files or commits the remote lacks): pass sync: \"keep\" to keep it or sync: \"reset\" to discard it" >&2
    exit 1
  fi
  action=synced
  have=$(g -C "$DIR" config --local --get remote.origin.url 2>/dev/null || true)
  if [ "$have" != "$URL" ]; then
    if [ "$SYNC" = keep ]; then
      printf '%s\\n' "the checkout at $DIR is of \${have:-no remote}, not $URL, and keep does not repoint it" >&2
      exit 1
    fi
    if [ -n "$have" ]; then g -C "$DIR" remote set-url origin "$URL"; else g -C "$DIR" remote add origin "$URL"; fi || exit 1
  fi
  # What the checkout already has seeds the throwaway repository, without the
  # token, so the fetch from the remote only downloads what is new.
  g --git-dir="$T" fetch --quiet --no-recurse-submodules "$DIR" '+refs/remotes/origin/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' >/dev/null 2>&1 || true
  auth --git-dir="$T" fetch --force --prune --quiet --no-recurse-submodules --tags -- "$URL" '+refs/heads/*:refs/remotes/origin/*' || exit 1
  g -C "$DIR" fetch --force --quiet --no-recurse-submodules --prune "$T" '+refs/remotes/origin/*:refs/remotes/origin/*' || exit 1
  if [ "$SYNC" = keep ]; then
    # A tag the agent made, or moved, is kept, so these are not forced.
    g -C "$DIR" fetch --quiet --no-recurse-submodules "$T" 'refs/tags/*:refs/tags/*' >/dev/null 2>&1 || true
  else
    g -C "$DIR" fetch --force --quiet --no-recurse-submodules "$T" '+refs/tags/*:refs/tags/*' || exit 1
  fi
  if [ -z "$REF" ]; then
    REF=$(auth --git-dir="$T" ls-remote --symref -- "$URL" HEAD | sed -n 's|^ref: refs/heads/\\(.*\\)[[:space:]][[:space:]]*HEAD$|\\1|p')
    [ -n "$REF" ] || { printf '%s\\n' "cannot find the default branch of $URL" >&2; exit 1; }
  fi
  # Keep also resumes a branch of the agent's own that the remote lacks.
  if ! known "$REF" && { [ "$SYNC" != keep ] || ! g -C "$DIR" show-ref --verify --quiet "refs/heads/$REF"; }; then
    printf '%s\\n' "$REF is not a branch, tag or commit of $URL" >&2
    exit 1
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
      if ! g -C "$DIR" merge --quiet --ff-only "origin/$REF" >/dev/null 2>&1; then
        action=diverged
        printf '%s\\n' "$REF was not fast-forwarded: it has local commits or changes in the way" >&2
      fi
    elif g -C "$DIR" show-ref --verify --quiet "refs/heads/$REF"; then
      g -C "$DIR" checkout --quiet "$REF" || exit 1
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
else
  # No checkout in the clone, which holds the token: filters and attributes
  # run in the tokenless checkout after it.
  if [ ! -e "$DIR" ]; then CLONING=new
  elif [ -d "$DIR" ] && [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then CLONING=empty; fi
  auth clone --quiet --no-checkout --no-recurse-submodules -- "$URL" "$DIR" || exit 1
  if [ -n "$REF" ] && ! known "$REF"; then
    printf '%s\\n' "$REF is not a branch, tag or commit of $URL" >&2
    exit 1
  fi
  # A name that is both a branch and a tag is the branch, as it is on sync.
  if [ -n "$REF" ] && g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    g -C "$DIR" checkout --quiet -f -B "$REF" "origin/$REF" || exit 1
  else
    g -C "$DIR" checkout --quiet -f "\${REF:-HEAD}" || exit 1
  fi
  action=cloned
fi
g -C "$DIR" config user.name "Coding agent" || exit 1
g -C "$DIR" config user.email "agent@users.noreply.github.com" || exit 1
CLONING=
printf 'repo:%s:%s\\n' "$action" "$(g -C "$DIR" rev-parse HEAD)"
`;

// Pushes through the throwaway repository, so the process that holds the token
// reads none of the checkout's configuration.
const pushScript = `${prelude}
SHA=$(g -C "$DIR" rev-parse --verify "refs/heads/$BRANCH") || exit 1
g -C "$DIR" push --quiet "$T" "$SHA:refs/heads/$BRANCH" || exit 1
auth --git-dir="$T" push --quiet -- "$URL" "$SHA:refs/heads/$BRANCH" || exit 1
# The push went to the URL, not a remote, so the checkout would not know the
# remote has these commits (a later sync would call them local work).
g -C "$DIR" update-ref "refs/remotes/origin/$BRANCH" "$SHA"
`;

/**
 * EXPERIMENTAL: Clones a repository into `sandbox` and returns a handle to push
 * branches from it. If `path` already holds a checkout, as in a sandbox
 * restored from a thread's snapshot, it is fetched and brought to `ref` instead
 * (see `sync`). The token stays out of the sandbox: it is only in the
 * environment of the clone, fetch and push commands. Git hooks are off for
 * these commands (the checkout is writable by the model, so a hook there could
 * read the token): a repository that relies on a `pre-push` hook, Git LFS for
 * one, does not get it, and neither does the LFS filter, which runs in a checkout that holds no token (a private repository's LFS files fail the checkout).
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
  const { ref, path = "/work", sync } = options;

  if (sync !== undefined && sync !== "reset" && sync !== "keep") {
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
    { URL: url, REF: ref === "HEAD" ? "" : (ref ?? ""), SYNC: sync ?? "" },
  );
  // The script's last line says what it did; anything before it is noise.
  const done = stdout
    .trim()
    .split("\n")
    .reverse()
    .map((line) => {
      return /^repo:(cloned|synced|diverged):([0-9a-f]+)$/.exec(line);
    })
    .find(Boolean);
  // Without the marker the result cannot be trusted, so it is an error rather
  // than a guess.
  if (!done) {
    throw new NonRetriableError(
      `git clone or fetch ${options.repo} printed no result line: ${stdout.slice(-200)}`,
    );
  }

  const action = done[1] as "cloned" | "synced" | "diverged";
  const sha = done[2] as string;

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
