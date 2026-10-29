/**
 * @module
 * EXPERIMENTAL: A checked git push that needs no `git` on the machine that
 * runs your app, so an agent can run on Cloudflare Workers or any runtime that
 * has `fetch`. It is the counterpart of `pushBundle()` in `gitPush.ts` and
 * answers to the same `GitPolicy`.
 *
 * Code in a sandbox, which has git, prints a manifest of the commits to push:
 * their authors, messages, the files they change and the content of each new
 * file. `pushManifest()` reads the manifest, shows the policy what it holds,
 * and only then rebuilds the commits on the remote with the GitHub Git Data API
 * (blobs, trees, commits, then the ref) using a token that exists nowhere but
 * in your app. What the policy sees is what is pushed, because the push is
 * built from the same manifest.
 *
 * It pushes to GitHub (github.com or an Enterprise server) and needs a linear
 * history on top of the remote's branch: a merge commit, a submodule change or
 * a path git prints in quotes is refused.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import {
  blobOf,
  type GitPolicy,
  type GitPolicyResult,
  type GitPush,
  type GitPushBlob,
  type GitPushFile,
  isPushableRef,
  maskSecrets,
  maxPolicyFileBytes,
  maxPushCommits,
  normalizeUrl,
  once,
  type PushedRef,
  type PushOutcome,
  readVerdict,
} from "./gitPush.ts";

/**
 * The shell script that makes the manifest inside the sandbox. It is given the
 * remote's commit to build on, the commit to push and a file to write, and
 * exits 4 when the sandbox does not have the remote's commit. It uses only
 * `sh`, `git`, `base64`, `tr`, `cut` and `grep`.
 */
export const manifestScript = `base=$1; tip=$2; out=$3
git cat-file -e "$base^{commit}" 2>/dev/null || exit 4
: > "$out"; : > "$out.seen"
for c in $(git rev-list --reverse --topo-order -n ${maxPushCommits + 1} "$tip" "^$base"); do
  {
    echo "COMMIT $c $(git rev-list --parents -n 1 "$c" | cut -s -d' ' -f2-)"
    git cat-file commit "$c" | sed '/^$/q' | grep -qE '^(gpgsig|gpgsig-sha256|encoding|mergetag) ' && echo "UNSUPPORTED"
    printf 'AUTHOR %s %s %s\\n' "$(printf %s "$(git -c log.showSignature=false log -1 --format=%an "$c")" | base64 | tr -d '\\n')" "$(printf %s "$(git -c log.showSignature=false log -1 --format=%ae "$c")" | base64 | tr -d '\\n')" "$(git -c log.showSignature=false log -1 --format=%aI "$c")"
    printf 'COMMITTER %s %s %s\\n' "$(printf %s "$(git -c log.showSignature=false log -1 --format=%cn "$c")" | base64 | tr -d '\\n')" "$(printf %s "$(git -c log.showSignature=false log -1 --format=%ce "$c")" | base64 | tr -d '\\n')" "$(git -c log.showSignature=false log -1 --format=%cI "$c")"
    printf 'MESSAGE %s\\n' "$(git cat-file commit "$c" | sed '1,/^$/d' | base64 | tr -d '\\n')"
    git -c core.quotePath=false diff-tree -r --no-renames --no-commit-id --root --raw "$c" | while IFS= read -r line; do
      meta=\${line%%\t*}; path=\${line#*\t}
      set -- $meta
      printf 'CHANGE %s %s %s %s %s %s\\n' "$5" "\${1#:}" "$2" "$3" "$4" "$(printf %s "$path" | base64 | tr -d '\\n')"
      case "$4" in *[!0]*) grep -qx "$4" "$out.seen" || { echo "$4" >> "$out.seen"; printf 'BLOB %s %s\\n' "$4" "$(git cat-file blob "$4" | base64 | tr -d '\\n')"; };; esac
    done
  } >> "$out"
done
rm -f "$out.seen"
`;

interface ManifestCommit {
  sha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  message: string;

  /**
   * The commit is signed, or has an encoding or a merge tag, which rebuilding
   * it through the API would change.
   */
  unsupported?: boolean;
  changes: {
    status: string;
    oldMode: string;
    mode: string;
    oldSha: string;
    sha: string;
    path: string;
  }[];
}

interface Manifest {
  commits: ManifestCommit[];
  blobs: Map<string, Uint8Array>;
}

const decodeBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }

  return bytes;
};

const decodeText = (text: string): string => {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(text));
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }

  return btoa(binary);
};

const sha1 = /^[0-9a-f]{40}$/;
const noSha = /^0+$/;

/**
 * Reads what \`manifestScript\` printed. A line it can't make sense of throws:
 * a manifest that is not exactly the script's output is not pushed.
 */
export const parseManifest = (text: string): Manifest => {
  const commits: ManifestCommit[] = [];
  const blobs = new Map<string, Uint8Array>();
  let current: ManifestCommit | undefined;

  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }

    const [kind = "", ...rest] = line.split(" ");

    if (kind === "COMMIT") {
      // A root commit has a trailing space and no parents.
      const [sha = "", ...parents] = rest.filter(Boolean);

      current = {
        sha,
        parents,
        author: { name: "", email: "", date: "" },
        committer: { name: "", email: "", date: "" },
        message: "",
        changes: [],
      };
      commits.push(current);

      if (![sha, ...parents].every((value) => sha1.test(value))) {
        throw new Error("the manifest has a commit that is not a SHA-1");
      }
    } else if (kind === "BLOB") {
      const [sha = "", content = ""] = rest;

      if (!sha1.test(sha)) {
        throw new Error("the manifest has a blob that is not a SHA-1");
      }

      blobs.set(sha, decodeBase64(content));
    } else if (!current) {
      throw new Error(`the manifest starts with ${kind}, not a commit`);
    } else if (kind === "AUTHOR" || kind === "COMMITTER") {
      const [name = "", email = "", date = ""] = rest;

      current[kind === "AUTHOR" ? "author" : "committer"] = {
        name: decodeText(name),
        email: decodeText(email),
        date,
      };
    } else if (kind === "UNSUPPORTED") {
      current.unsupported = true;
    } else if (kind === "MESSAGE") {
      current.message = decodeText(rest[0] ?? "");
    } else if (kind === "CHANGE") {
      const [
        status = "",
        oldMode = "",
        mode = "",
        oldSha = "",
        sha = "",
        path = "",
      ] = rest;

      current.changes.push({
        status,
        oldMode,
        mode,
        oldSha,
        sha,
        path: decodeText(path),
      });
    } else {
      throw new Error(`the manifest has an unknown line: ${kind}`);
    }
  }

  return { commits, blobs };
};

/**
 * One file's change as a unified diff, enough for a policy to scan for what
 * was added. Two files whose lines multiply to over 4 million are shown as a
 * replacement of the whole.
 */
const unifiedDiff = (
  path: string,
  before: GitPushBlob | undefined,
  after: GitPushBlob | undefined,
): string => {
  const head = `diff --git a/${path} b/${path}\n`;

  if (before?.text === undefined && before !== undefined) {
    return `${head}Binary files differ\n`;
  }

  if (after?.text === undefined && after !== undefined) {
    return `${head}Binary files differ\n`;
  }

  const a = before?.text === undefined ? [] : lines(before.text);
  const b = after?.text === undefined ? [] : lines(after.text);
  const from = before ? `a/${path}` : "/dev/null";
  const to = after ? `b/${path}` : "/dev/null";
  const body: string[] = [];

  if (a.length * b.length > 4_000_000) {
    body.push(...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`));
  } else {
    // Longest common subsequence of lines, then the edit script from it.
    const table: number[][] = Array.from({ length: a.length + 1 }, () => {
      return new Array<number>(b.length + 1).fill(0);
    });

    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        (table[i] as number[])[j] =
          a[i] === b[j]
            ? ((table[i + 1] as number[])[j + 1] as number) + 1
            : Math.max(
                (table[i + 1] as number[])[j] as number,
                (table[i] as number[])[j + 1] as number,
              );
      }
    }

    let i = 0;
    let j = 0;

    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        body.push(` ${a[i]}`);
        i += 1;
        j += 1;
      } else if (
        j < b.length &&
        (i === a.length ||
          ((table[i] as number[])[j + 1] as number) >=
            ((table[i + 1] as number[])[j] as number))
      ) {
        body.push(`+${b[j]}`);
        j += 1;
      } else {
        body.push(`-${a[i]}`);
        i += 1;
      }
    }
  }

  return `${head}--- ${from}\n+++ ${to}\n@@ -1,${a.length} +1,${b.length} @@\n${body.join("\n")}\n`;
};

const lines = (text: string): string[] => {
  const split = text.split("\n");

  if (split.at(-1) === "") {
    split.pop();
  }

  return split;
};

/**
 * Where a GitHub remote's API is: github.com's, or an Enterprise server's
 * \`/api/v3\`. \`api\` overrides it.
 */
const apiTarget = (
  remote: string,
  api: string | undefined,
): { base: string; owner: string; repo: string } => {
  let url: URL;

  try {
    url = new URL(normalizeUrl(remote));
  } catch {
    throw new Error(`${remote} is not a URL`);
  }

  const [owner, repo, ...extra] = url.pathname.split("/").filter(Boolean);

  if (!owner || !repo || extra.length > 0) {
    throw new Error(
      `${remote} is not a GitHub repository URL like https://github.com/owner/repo`,
    );
  }

  return {
    base: (
      api ??
      (url.host === "github.com"
        ? "https://api.github.com"
        : `${url.origin}/api/v3`)
    ).replace(/\/+$/, ""),
    owner,
    repo,
  };
};

/**
 * Whether `remote` is a repository URL the API push can address:
 * `https://host/owner/repo`.
 */
export const isApiRemote = (remote: string): boolean => {
  try {
    apiTarget(remote, undefined);

    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `remote` is on github.com, the one host `transport: "auto"` takes
 * for GitHub on its own. Another host (GitHub Enterprise) needs `api` or
 * `transport: "api"`.
 */
export const isGitHubRemote = (remote: string): boolean => {
  try {
    return (
      isApiRemote(remote) &&
      ["github.com", "www.github.com"].includes(
        new URL(normalizeUrl(remote)).host,
      )
    );
  } catch {
    return false;
  }
};

/**
 * What the GitHub API said to a request that failed.
 */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,

    /**
     * Whether trying again can work: a server error, a rate limit.
     */
    readonly retryable = false,
  ) {
    super(message);
  }
}

const isRetryable = (response: Response): boolean => {
  return (
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  );
};

export interface GitHubClient {
  /**
   * The current commit of \`ref\` (\`heads/main\`), or \`undefined\` when there is
   * none.
   */
  refSha: (ref: string) => Promise<string | undefined>;

  /**
   * The commit the repository's default branch points at.
   */
  defaultTip: () => Promise<string>;
  file: (path: string, ref: string) => Promise<Uint8Array | undefined>;
}

const clientFor = (options: {
  remote: string;
  token: string;
  api?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) => {
  const { base, owner, repo } = apiTarget(options.remote, options.api);
  const send = options.fetch ?? globalThis.fetch;
  const secrets = [options.token];

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<Response> => {
    const response = await send(`${base}/repos/${owner}/${repo}${path}`, {
      method,
      signal: options.signal,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "inngest-agent",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    return response;
  };

  const json = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request(method, path, body);
    const text = await response.text();

    if (!response.ok) {
      throw new ApiError(
        maskSecrets(
          `GitHub ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`,
          secrets,
        ),
        response.status,
        isRetryable(response),
      );
    }

    return JSON.parse(text) as T;
  };

  const encodePath = (path: string): string => {
    return path.split("/").map(encodeURIComponent).join("/");
  };

  return {
    json,
    secrets,
    refSha: async (ref: string): Promise<string | undefined> => {
      try {
        const found = await json<{ object: { sha: string } }>(
          "GET",
          `/git/ref/${ref}`,
        );

        return found.object.sha;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return undefined;
        }

        throw error;
      }
    },
    defaultTip: async (): Promise<string> => {
      const info = await json<{ default_branch: string }>("GET", "");
      const sha = await (async () => {
        const found = await json<{ object: { sha: string } }>(
          "GET",
          `/git/ref/heads/${info.default_branch}`,
        );

        return found.object.sha;
      })();

      return sha;
    },
    file: async (
      path: string,
      ref: string,
    ): Promise<Uint8Array | undefined> => {
      const response = await request(
        "GET",
        `/contents/${encodePath(path)}?ref=${ref}`,
      );

      if (response.status === 404) {
        return undefined;
      }

      if (!response.ok) {
        throw new ApiError(
          maskSecrets(
            `GitHub GET contents/${path} answered ${response.status}`,
            secrets,
          ),
          response.status,
          isRetryable(response),
        );
      }

      const body = (await response.json()) as
        | unknown[]
        | {
            type: string;
            sha: string;
            size: number;
            encoding?: string;
            content?: string;
          };

      // A directory answers with a listing, which is no file.
      if (Array.isArray(body)) {
        return undefined;
      }

      if (body.type === "submodule") {
        throw new Error(`${path} is a submodule, which a policy can't read`);
      }

      if (body.size > maxPolicyFileBytes) {
        throw new Error(
          `${path} is ${body.size} bytes, more than the ${maxPolicyFileBytes} a policy can read`,
        );
      }

      if (body.size === 0) {
        return new Uint8Array();
      }

      if (body.encoding === "base64" && body.content) {
        return decodeBase64(body.content);
      }

      // A file the contents API doesn't inline, and a symlink, come as a blob.
      const blob = await json<{ content: string }>(
        "GET",
        `/git/blobs/${body.sha}`,
      );

      return decodeBase64(blob.content);
    },
  };
};

/**
 * What a push needs to know of the remote before the sandbox makes its
 * manifest: the commit the ref has now (none for a new branch), and the commit
 * the manifest builds on, which for a new branch is the default branch's.
 */
export const remoteState = async (options: {
  remote: string;
  ref: string;
  token: string;
  api?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ oldSha?: string; base: string }> => {
  const client = clientFor(options);

  try {
    const oldSha = await client.refSha(options.ref.replace(/^refs\//, ""));

    return oldSha !== undefined
      ? { oldSha, base: oldSha }
      : { base: await client.defaultTip() };
  } catch (error) {
    // A request that can't succeed on a retry (no access, an empty
    // repository, a missing one) ends the step instead of repeating it.
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !error.retryable
    ) {
      throw new NonRetriableError(
        error.status === 409
          ? "the repository is empty, so there is no branch to build on"
          : error.message,
        { cause: error },
      );
    }

    throw error;
  }
};

/**
 * Whether `text` has a backslash or a control character.
 */
const hasBackslashOrControl = (text: string): boolean => {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);

    if (code < 32 || code === 92) {
      return true;
    }
  }

  return false;
};

/**
 * Whether `path` is one git could hold and a policy would read the way git
 * does: no empty, `.`, `..` or `.git` part, no leading slash, no backslash
 * and no control character.
 */
export const isPlainPath = (path: string): boolean => {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !hasBackslashOrControl(path) &&
    path.split("/").every((part) => {
      // The names the file systems of other platforms would read as .git.
      const folded = part
        .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
        .replace(/[. ]+$/, "")
        .toLowerCase();

      return (
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        folded !== ".git" &&
        folded !== "git~1"
      );
    })
  );
};

export interface PushManifestOptions {
  remote: string;

  /**
   * The token, used only for the requests the host makes.
   */
  token: string;

  /**
   * The API's base URL. Default: \`https://api.github.com\`, or \`/api/v3\` of an
   * Enterprise host.
   */
  api?: string;
  fetch?: typeof fetch;

  /**
   * What \`manifestScript\` printed.
   */
  manifest: string;

  /**
   * The ref to update on the remote, and the one the sandbox pushed from.
   */
  target: { src: string; dst: string };

  /**
   * The sandbox's commit that the manifest ends at.
   */
  tip: string;

  /**
   * What the remote has at \`target.dst\` now, and the commit the manifest
   * builds on (see \`remoteState\`).
   */
  state: { oldSha?: string; base: string };
  policy?: GitPolicy;
  signal?: AbortSignal;
}

const modeIsFile = (mode: string): boolean => {
  return mode === "100644" || mode === "100755" || mode === "120000";
};

/**
 * Checks a manifest against the policy and pushes it with the GitHub API. A
 * refusal and a failure of the push come back as data, like \`pushBundle()\`.
 */
export const pushManifest = async (
  options: PushManifestOptions,
): Promise<PushOutcome> => {
  let parsed: Manifest;

  try {
    parsed = parseManifest(options.manifest);
  } catch (error) {
    // Text that isn't UTF-8 in a path, a name or a message can't be rebuilt
    // the way it was written.
    return {
      refused: `this push can't be made without git: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return pushParsed(options, parsed);
};

const pushParsed = async (
  options: Omit<PushManifestOptions, "manifest"> & { skipEmpty?: boolean },
  parsed: Manifest,
): Promise<PushOutcome> => {
  const { remote, target, tip, state, policy } = options;
  const client = clientFor(options);
  const { commits, blobs } = parsed;
  const skipEmpty = "skipEmpty" in options && options.skipEmpty === true;

  if (commits.length === 0) {
    return { refused: "there is nothing to push: no new commits" };
  }

  if (commits.length > maxPushCommits) {
    return {
      refused: `a push may have at most ${maxPushCommits} new commits`,
    };
  }

  for (const commit of commits) {
    if (commit.unsupported) {
      return {
        refused: `commit ${commit.sha} is signed or has an encoding or a merge tag, which a push without git can't reproduce`,
      };
    }

    if (commit.parents.length !== 1) {
      return {
        refused:
          "a push without git can't carry a merge commit or a root commit; rebase it onto the remote's branch",
      };
    }

    // Two entries for a path (or a file where a directory is) would leave the
    // policy checking one and the tree holding another.
    const seen = new Set<string>();

    for (const change of commit.changes) {
      const clash =
        seen.has(change.path) ||
        commit.changes.some((other) => {
          return other.path.startsWith(`${change.path}/`);
        });

      if (clash) {
        return {
          refused: `${change.path} appears twice in a commit of this push`,
        };
      }

      seen.add(change.path);

      if (change.path.startsWith('"') || !isPlainPath(change.path)) {
        return {
          refused: "a path in this push has characters git_push can't check",
        };
      }

      if (
        (change.mode !== "000000" && !modeIsFile(change.mode)) ||
        (change.oldMode !== "000000" &&
          change.oldMode !== "" &&
          !modeIsFile(change.oldMode))
      ) {
        return {
          refused: `${change.path} is a submodule or another kind of entry that a push without git can't carry`,
        };
      }

      if (!noSha.test(change.sha) && !blobs.has(change.sha)) {
        return {
          refused: `the manifest lacks the content of ${change.path}`,
        };
      }
    }
  }

  // The first new commit must sit on the commit the manifest was built on,
  // and each of the others on the one before it.
  const linear = commits.every((commit, at) => {
    return commit.parents[0] === (at === 0 ? state.base : commits[at - 1]?.sha);
  });
  const fastForward =
    linear && (state.oldSha === undefined || state.oldSha === state.base);
  const paths = [
    ...new Set(
      commits.flatMap((commit) => {
        return commit.changes.map((change) => change.path);
      }),
    ),
  ].sort();
  const newestFirst = [...commits].reverse();
  const afterBlob = (change: ManifestCommit["changes"][number]) => {
    return noSha.test(change.sha)
      ? undefined
      : { ...blobOf(blobs.get(change.sha) as Uint8Array), mode: change.mode };
  };
  const baseFile = once(async () => {
    return new Map<string, GitPushBlob | undefined>();
  });
  const fromBase = async (path: string): Promise<GitPushBlob | undefined> => {
    const cache = await baseFile();

    if (!cache.has(path)) {
      const bytes = await client.file(path, state.base);

      // The contents API says nothing of a file's mode, and the manifest's
      // word for it is not checked, so the file before has no mode here.
      cache.set(path, bytes === undefined ? undefined : blobOf(bytes));
    }

    return cache.get(path);
  };
  // The content of \`path\` just before commit \`index\`.
  const contentBefore = async (
    index: number,
    path: string,
  ): Promise<GitPushBlob | undefined> => {
    for (let at = index - 1; at >= 0; at -= 1) {
      const change = (commits[at] as ManifestCommit).changes.find((entry) => {
        return entry.path === path;
      });

      if (change) {
        return afterBlob(change);
      }
    }

    return fromBase(path);
  };
  const contentAfter = (path: string): Promise<GitPushBlob | undefined> => {
    return contentBefore(commits.length, path);
  };

  let ref = target.dst;
  let notes: string[] = [];

  if (policy) {
    const files: GitPushFile[] = paths.map((path) => {
      return {
        path,
        before: once(() => {
          return fromBase(path);
        }),
        after: once(() => {
          return contentAfter(path);
        }),
      };
    });
    let decision: GitPolicyResult;

    try {
      decision = await policy({
        remote,
        ref,
        ...(ref.startsWith("refs/heads/") && {
          branch: ref.slice("refs/heads/".length),
        }),
        sha: tip,
        ...(state.oldSha !== undefined && { oldSha: state.oldSha }),
        fastForward,
        commits: newestFirst.map((commit) => {
          return {
            sha: commit.sha,
            author: commit.author.name,
            subject: commit.message.split("\n")[0] ?? "",
          };
        }),
        paths,
        files,
        patch: async () => {
          const out: string[] = [];

          for (const commit of newestFirst) {
            const index = commits.indexOf(commit);

            out.push(`${commit.sha} ${commit.message.split("\n")[0] ?? ""}\n`);

            for (const change of commit.changes) {
              out.push(
                unifiedDiff(
                  change.path,
                  await contentBefore(index, change.path),
                  afterBlob(change),
                ),
              );
            }
          }

          return out.join("");
        },
      } satisfies GitPush);
    } catch (error) {
      // A file the policy reads can fail to load; a retry helps only if the
      // API's answer was a temporary one.
      if (error instanceof ApiError && !error.retryable) {
        return { failed: error.message };
      }

      throw error;
    }
    const verdict = readVerdict(decision, ref);

    if ("refuse" in verdict) {
      return { refused: verdict.refuse };
    }

    ref = verdict.ref;
    notes = verdict.notes;
  }

  const asked = ref === target.dst;
  const pushedRef = (
    status: PushedRef["status"],
    sha: string,
    previous = asked ? state.oldSha : undefined,
  ): PushedRef => {
    return {
      src: target.src,
      ref,
      sha,
      ...(previous !== undefined && { oldSha: previous }),
      status,
      asked,
      ...(notes.length > 0 && { notes }),
    };
  };

  // History that doesn't continue from the commit the manifest was built on
  // can't be rebuilt there, whatever ref it is meant for.
  if (!linear || (!fastForward && asked)) {
    return { pushed: [pushedRef("non-fast-forward", tip)] };
  }

  try {
    const blobShas = new Map<string, string>();
    let parent = state.base;
    let parentTree = (
      await client.json<{ tree: { sha: string } }>(
        "GET",
        `/git/commits/${state.base}`,
      )
    ).tree.sha;

    for (const commit of commits) {
      const entries: {
        path: string;
        mode: string;
        type: "blob";
        sha: string | null;
      }[] = [];

      for (const change of commit.changes) {
        if (noSha.test(change.sha)) {
          entries.push({
            path: change.path,
            mode: "100644",
            type: "blob",
            sha: null,
          });

          continue;
        }

        let created = blobShas.get(change.sha);

        if (!created) {
          const made = await client.json<{ sha: string }>(
            "POST",
            "/git/blobs",
            {
              content: encodeBase64(blobs.get(change.sha) as Uint8Array),
              encoding: "base64",
            },
          );

          if (made.sha !== change.sha) {
            return {
              refused: `the content of ${change.path} does not match its hash`,
            };
          }

          created = made.sha;
          blobShas.set(change.sha, created);
        }

        entries.push({
          path: change.path,
          mode: change.mode,
          type: "blob",
          sha: created,
        });
      }

      const tree = await client.json<{ sha: string }>("POST", "/git/trees", {
        base_tree: parentTree,
        tree: entries,
      });

      if (skipEmpty && tree.sha === parentTree) {
        return { refused: "the commit would change nothing" };
      }

      const made = await client.json<{ sha: string }>("POST", "/git/commits", {
        message: commit.message,
        tree: tree.sha,
        parents: [parent],
        author: commit.author,
        committer: commit.committer,
      });

      parentTree = tree.sha;
      parent = made.sha;
    }

    const name = ref.replace(/^refs\//, "");
    const current = await client.refSha(name);

    if (current === undefined) {
      try {
        await client.json("POST", "/git/refs", { ref, sha: parent });
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
          // Made by someone else since the check above, or refused by a rule.
          return (await client.refSha(name)) !== undefined
            ? { pushed: [pushedRef("non-fast-forward", parent)] }
            : { failed: error.message };
        }

        throw error;
      }
    } else if (current !== parent) {
      try {
        await client.json("PATCH", `/git/refs/${name}`, {
          sha: parent,
          force: false,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
          // Not a fast-forward if the ref moved or does not sit on the commit
          // this push builds on; otherwise a rule (a protected branch) said no.
          return (await client.refSha(name)) !== current ||
            (asked && current !== state.base)
            ? {
                pushed: [pushedRef("non-fast-forward", parent, current)],
              }
            : { failed: error.message };
        }

        throw error;
      }
    }

    return { pushed: [pushedRef("pushed", parent, current)] };
  } catch (error) {
    if (error instanceof ApiError) {
      // A server error or a rate limit is tried again by the step.
      if (error.retryable) {
        throw error;
      }

      return { failed: error.message };
    }

    throw error;
  }
};

export interface CommitFilesOptions {
  remote: string;

  /**
   * The token, used only for the requests the host makes.
   */
  token: string;
  api?: string;
  fetch?: typeof fetch;

  /**
   * The full ref to commit to, such as `refs/heads/skills/fix`. A branch that
   * does not exist yet starts from the repository's default branch.
   */
  ref: string;
  message: string;

  /**
   * The files by path: text or bytes to write, or `null` to delete the path.
   * A file is written with mode 100644; give `{ content, executable: true }`
   * for 100755. A file that is executable now and is written as plain content
   * loses the bit.
   */
  files: Record<
    string,
    | string
    | Uint8Array
    | null
    | { content: string | Uint8Array; executable?: boolean }
  >;
  author?: { name: string; email: string };

  /**
   * When the commit is made, as an ISO date. Default now; compute it in the
   * step before calling so that a retry makes the same commit.
   */
  date?: string;

  /**
   * Checks the commit like `git_push`'s policy does. The push it sees has
   * `sha` empty, since the commit does not exist until it is made.
   */
  policy?: GitPolicy;
  signal?: AbortSignal;
}

const gitBlobSha = async (bytes: Uint8Array): Promise<string> => {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const whole = new Uint8Array(head.length + bytes.length);

  whole.set(head);
  whole.set(bytes, head.length);

  const digest = await crypto.subtle.digest("SHA-1", whole);

  return [...new Uint8Array(digest)]
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
};

/**
 * EXPERIMENTAL: Commits a set of files to a GitHub repository from your app,
 * with no sandbox and no `git`: one commit on top of the branch (or of the
 * default branch, for a new one), made with the Git Data API and a token that
 * stays in your app. It answers to the same `GitPolicy` and returns the same
 * result as the `git_push` tool's push, so a file set an agent wrote, a skill
 * or an experiment goes through the same checks. Call it inside a step.
 *
 * @example
 * ```ts
 * const outcome = await commitFiles({
 *   remote: "https://github.com/acme/skills",
 *   token,
 *   ref: "refs/heads/skills/triage",
 *   message: "Add the triage skill",
 *   files: { "triage/SKILL.md": text, "old/SKILL.md": null },
 * });
 * ```
 */
export const commitFiles = async (
  options: CommitFilesOptions,
): Promise<PushOutcome> => {
  const paths = Object.keys(options.files);

  if (paths.length === 0) {
    return { refused: "there are no files to commit" };
  }

  const bad = paths.find((path) => {
    return !isPlainPath(path);
  });

  if (bad !== undefined) {
    return { refused: `${bad} is not a path a commit can carry` };
  }

  if (!isPushableRef(options.ref)) {
    throw new Error(`${options.ref} is not a ref a commit may be pushed to`);
  }

  const state = await remoteState(options);
  const blobs = new Map<string, Uint8Array>();
  const changes: ManifestCommit["changes"] = [];

  for (const path of paths) {
    const content = options.files[path];

    if (content === null || content === undefined) {
      changes.push({
        status: "D",
        oldMode: "",
        mode: "000000",
        oldSha: "",
        sha: "0".repeat(40),
        path,
      });

      continue;
    }

    const written =
      content instanceof Uint8Array || typeof content === "string"
        ? { content }
        : content;
    const bytes =
      typeof written.content === "string"
        ? new TextEncoder().encode(written.content)
        : written.content;
    const sha = await gitBlobSha(bytes);

    blobs.set(sha, bytes);
    changes.push({
      status: "M",
      oldMode: "",
      mode: "executable" in written && written.executable ? "100755" : "100644",
      oldSha: "",
      sha,
      path,
    });
  }

  const who = options.author ?? {
    name: "inngest-agent",
    email: "agent@users.noreply.github.com",
  };
  const date = options.date ?? new Date().toISOString();
  const person = { ...who, date };

  return pushParsed(
    {
      remote: options.remote,
      token: options.token,
      api: options.api,
      fetch: options.fetch,
      target: { src: options.ref, dst: options.ref },
      tip: "",
      state,
      policy: options.policy,
      signal: options.signal,
      skipEmpty: true,
    },
    {
      commits: [
        {
          sha: "",
          parents: [state.base],
          author: person,
          committer: person,
          message: options.message,
          changes,
        },
      ],
      blobs,
    },
  );
};
