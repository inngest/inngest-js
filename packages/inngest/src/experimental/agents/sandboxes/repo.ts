/**
 * @module
 * EXPERIMENTAL: the `repo` of a sandbox definition. The sandbox starts with a
 * git repository checked out (first, before skill files and `setup`), and the
 * host makes the one push: the sandbox bundles its new commits and holds no
 * credential, your `policy` sees what would change, and the host pushes with a
 * write token that never enters the sandbox.
 *
 * The checkout runs in the sandbox with a short-lived read-only token, which
 * is only in the environment of the one git process that talks to the remote
 * (redacted from traces), and never written to git config or a file, so the
 * model's own commands can't read it.
 *
 * ```ts
 * const work = sandbox({
 *   id: "work",
 *   tools: sandbox.tools.defaults,
 *   repo: {
 *     url: "acme/app",
 *     auth: { read: mintReadToken, write: mintWriteToken },
 *     policy: ({ branch }) => {
 *       if (!branch?.startsWith("agent/")) {
 *         return { refuse: "Branches for the agent start with agent/" };
 *       }
 *     },
 *   },
 * });
 * ```
 */
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import type { GitPolicy } from "../../../components/sandbox/gitPush.ts";
import { Secret } from "../../../components/sandbox/secret.ts";
import type {
  DurableSandbox,
  SandboxIO,
} from "../../../components/sandbox/types.ts";
import { type HostPushOptions, pushBranch } from "./gitPush.ts";

/**
 * Anything that mints a repository token: a `secret()`, or a function that is
 * asked for `"read"` or `"write"` access and returns a token.
 */
export type RepoToken =
  | Secret
  | ((request: { access: "read" | "write" }) => string | Promise<string>);

/**
 * How a repo gets its tokens. It is asked for read-only access at checkout
 * and for write access at push, each minted inside a step and short-lived. A
 * single token is used for both, so it should be read-only (it fits
 * `push: false`); an agent that pushes uses `{ read, write }`.
 */
export type RepoAuth = RepoToken | { read: RepoToken; write: RepoToken };

/**
 * The repository a sandbox starts with.
 */
export interface RepoConfig {
  /**
   * A GitHub `owner/name`, or any git URL or path.
   */
  url: string;

  /**
   * Branch, tag or commit to check out. Default: the repository's default
   * branch. `"HEAD"` means the same.
   */
  ref?: string;

  /**
   * Mints the tokens for the checkout (read) and the push (write). Without
   * it only public repositories can be cloned and nothing can be pushed.
   */
  auth?: RepoAuth;

  /**
   * Decides each push before it happens: it sees `branch`, `commits` and
   * `paths`, and returns `{ refuse }` or `{ notes }`.
   */
  policy?: GitPolicy;

  /**
   * Whether the model gets a `<sandbox>_push` tool. `false` leaves it out;
   * `repo.push()` still works in code. Default `true`.
   */
  push?: boolean;

  /**
   * Where to check out. Default `"/work"`.
   */
  path?: string;

  /**
   * The git author of commits made in the sandbox. Default `inngest-agent`.
   */
  author?: { name: string; email: string };

  /**
   * There is no sync option: an existing checkout is left alone when a paused
   * sandbox resumes, unless the run asks for a different `ref`.
   */
  sync?: never;
}

/**
 * A sandbox's `repo`: a value, or a function of the run's start, which may be
 * async and must be pure. It is evaluated once per run.
 */
export type RepoValue =
  | RepoConfig
  | ((context: {
      // Deliberate unknown: event data comes from outside; the reader checks it.
      event: { name: string; data?: unknown };
      thread: { key: string };
    }) => RepoConfig | Promise<RepoConfig>);

/**
 * What a push returns.
 */
export interface PushResult {
  /**
   * The branch that was pushed.
   */
  branch: string;

  /**
   * The commit the remote's branch points at now.
   */
  sha: string;

  /**
   * What the policy returned in `notes`.
   */
  notes: string[];
}

/**
 * Thrown by `repo.push()` when the policy refuses the push. It is not retried.
 */
export class PushRefusedError extends NonRetriableError {
  readonly reason: string;

  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.name = "PushRefusedError";
    this.reason = reason;
  }
}

/**
 * The repository of a sandbox, as the handler sees it.
 */
export interface Repo {
  /**
   * Where the repository is checked out in the sandbox.
   */
  readonly path: string;

  /**
   * Pushes a local branch to the remote under the same name. The sandbox
   * bundles its new commits, `policy` checks them, and the host pushes with
   * the write token. It sends the commits that are there and never forces or
   * deletes. A refusal throws `PushRefusedError`.
   */
  push(branch: string): Promise<PushResult>;
}

/**
 * The defaults applied: what the checkout and the push work from.
 */
export interface ResolvedRepo extends RepoConfig {
  path: string;
}

const defaultAuthor = {
  name: "inngest-agent",
  email: "inngest-agent@users.noreply.github.com",
};

const tokenOf = async (
  auth: RepoToken,
  access: "read" | "write",
): Promise<string> => {
  return auth instanceof Secret ? auth.value() : auth({ access });
};

/**
 * Mints a token for `access`, or undefined when the repo has no `auth`. Call
 * it inside a step.
 */
export const mintRepoToken = async (
  auth: RepoAuth | undefined,
  access: "read" | "write",
): Promise<string | undefined> => {
  if (!auth) {
    return undefined;
  }

  const token =
    typeof auth === "object" && !(auth instanceof Secret) && "read" in auth
      ? auth[access]
      : (auth as RepoToken);

  return tokenOf(token, access);
};

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

// Clones into an empty path. A checkout that is already there (a resumed
// sandbox) is left alone, except when the run asks for a different ref: that
// ref is fetched and checked out, and uncommitted changes to tracked files make
// it an error. The last line it prints is `repo:<action>:<sha>`.
const checkoutScript = `${prelude}
if [ -e "$DIR/.git" ]; then
  action=kept
  CUR=$(g -C "$DIR" rev-parse HEAD) || exit 1
  NOW=$(g -C "$DIR" symbolic-ref -q --short HEAD || true)
  if [ -n "$REF" ] && [ "$REF" != "$NOW" ] && [ "$REF" != "$CUR" ]; then
    # What the checkout already has seeds the throwaway repository, without the
    # token, so the fetch from the remote only downloads what is new.
    g --git-dir="$T" fetch --quiet --no-recurse-submodules "$DIR" '+refs/remotes/origin/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' >/dev/null 2>&1 || true
    auth --git-dir="$T" fetch --force --prune --quiet --no-recurse-submodules --tags -- "$URL" '+refs/heads/*:refs/remotes/origin/*' || exit 1
    g -C "$DIR" fetch --force --quiet --no-recurse-submodules --prune "$T" '+refs/remotes/origin/*:refs/remotes/origin/*' || exit 1
    g -C "$DIR" fetch --quiet --no-recurse-submodules "$T" 'refs/tags/*:refs/tags/*' >/dev/null 2>&1 || true
    if g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      BRANCHY=1
      TARGET=$(g -C "$DIR" rev-parse --verify "refs/remotes/origin/$REF^{commit}") || exit 1
    else
      BRANCHY=
      TARGET=$(g -C "$DIR" rev-parse --verify -q "$REF^{commit}") || { printf '%s\\n' "$REF is not a branch, tag or commit of $URL" >&2; exit 1; }
    fi
    # The same commit under another name is the same ref.
    if [ "$TARGET" != "$CUR" ]; then
      g -C "$DIR" update-index -q --refresh >/dev/null 2>&1 || true
      if ! g -C "$DIR" diff-index --quiet HEAD --; then
        printf '%s\\n' "uncommitted changes to tracked files in $DIR block checking out $REF: commit or discard them first" >&2
        exit 1
      fi
      if [ -n "$BRANCHY" ]; then
        g -C "$DIR" checkout --quiet -B "$REF" "origin/$REF" || exit 1
      else
        g -C "$DIR" checkout --quiet --detach "$TARGET" || exit 1
      fi
      action=switched
    fi
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
  # A name that is both a branch and a tag is the branch.
  if [ -n "$REF" ] && g -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    g -C "$DIR" checkout --quiet -f -B "$REF" "origin/$REF" || exit 1
  else
    g -C "$DIR" checkout --quiet -f "\${REF:-HEAD}" || exit 1
  fi
  action=cloned
fi
g -C "$DIR" config user.name "$AUTHOR_NAME" || exit 1
g -C "$DIR" config user.email "$AUTHOR_EMAIL" || exit 1
HEADSHA=$(g -C "$DIR" rev-parse HEAD) || exit 1
CLONING=
printf 'repo:%s:%s\\n' "$action" "$HEADSHA"
`;

const urlOf = (url: string): string => {
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}.git` : url;
};

/**
 * Checks the repository out into the sandbox (see `checkoutScript`). Mints the
 * read token with `mintRead`, which the caller runs inside a step.
 */
export const checkoutRepo = async (
  sandbox: Pick<DurableSandbox, "commands">,
  config: ResolvedRepo,
  mintRead: () => Promise<string | null | undefined>,
  step = "repo:checkout",
): Promise<{ action: "cloned" | "kept" | "switched"; sha: string }> => {
  const { url, ref, path } = config;

  if (url.startsWith("-")) {
    throw new NonRetriableError(`repo url can't start with "-": ${url}`);
  }

  if (ref?.startsWith("-")) {
    throw new NonRetriableError(`repo ref can't start with "-": ${ref}`);
  }

  const author = config.author ?? defaultAuthor;
  const token = await mintRead();
  const result = await sandbox.commands.run(
    { id: step, name: `git checkout ${url}` },
    ["/bin/sh", "-c", checkoutScript],
    {
      environment: {
        GIT_TOKEN: token ?? "",
        DIR: path,
        URL: urlOf(url),
        REF: ref === "HEAD" ? "" : (ref ?? ""),
        AUTHOR_NAME: author.name,
        AUTHOR_EMAIL: author.email,
      },
    },
  );

  if (result.exitCode !== 0) {
    throw new NonRetriableError(
      `git checkout of ${url} failed: ${result.stderr.trim()}`,
    );
  }

  // The script's last line says what it did; anything before it is noise.
  const done = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .map((line) => {
      return /^repo:(cloned|kept|switched):([0-9a-f]+)$/.exec(line);
    })
    .find(Boolean);

  // Without the marker the result cannot be trusted, so it is an error rather
  // than a guess.
  if (!done) {
    throw new NonRetriableError(
      `git checkout of ${url} printed no result line: ${result.stdout.slice(-200)}`,
    );
  }

  return {
    action: done[1] as "cloned" | "kept" | "switched",
    sha: done[2] as string,
  };
};

/**
 * The `repo` handle of a sandbox: the host push, with the sandbox's
 * remote-tracking branch moved on to what was pushed, so a later checkout
 * doesn't call the pushed commits local work.
 */
export const createRepo = (sandbox: SandboxIO, config: ResolvedRepo): Repo => {
  const remote = urlOf(config.url).replace(/\.git$/, "");

  return {
    path: config.path,
    push: async (branch) => {
      if (!config.auth) {
        throw new NonRetriableError(
          "this repo has no auth, so nothing can be pushed: give it { read, write }",
        );
      }

      const options: HostPushOptions = {
        remote,
        token: async () => {
          return (await mintRepoToken(config.auth, "write")) as string;
        },
        policy: config.policy,
        cwd: config.path,
      };
      const result = await pushBranch(sandbox, options, branch, {
        idempotencyKey: `repo-push:${branch}`,
      });

      if (!result.ok) {
        if (result.refused !== undefined) {
          throw new PushRefusedError(result.refused);
        }

        throw new NonRetriableError(
          `git push ${branch} failed: ${result.error}`,
        );
      }

      const [pushed] = result.pushed;

      if (result.pushed.every((each) => !each.sandboxSha)) {
        await sandbox.commands.run(
          `repo-push:track:${branch}`,
          [
            "/bin/sh",
            "-c",
            'git update-ref "refs/remotes/origin/$1" "$(git rev-parse --verify "refs/heads/$1")" || true',
            "sh",
            branch,
          ],
          { cwd: config.path },
        );
      }

      return { branch, sha: pushed?.sha ?? "", notes: pushed?.notes ?? [] };
    },
  };
};
