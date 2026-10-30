/**
 * @module
 * EXPERIMENTAL: The host side of a checked git push, used by the `git_push`
 * agent tool.
 *
 * Code in a sandbox bundles the branch it wants to push. The bundle comes
 * home, and `pushBundle()` unpacks it on the host, works out from the objects
 * what the push really changes (the commits, the paths, whether it fast
 * forwards), asks your policy, and only then pushes with a token that exists
 * nowhere but in your app. Nothing the policy sees is taken from the sandbox
 * on trust.
 *
 * The host needs `git`.
 */

/**
 * A branch or tag update that code in the sandbox asked for, as your policy
 * sees it. It is computed on the host from the objects that were sent, so
 * nothing in it is taken from the sandbox on trust.
 */
export interface GitPush {
  /**
   * The repository it goes to.
   */
  remote: string;

  /**
   * The ref it updates, such as `refs/heads/agent/fix`.
   */
  ref: string;

  /**
   * The branch name when `ref` is a branch, such as `agent/fix`.
   */
  branch?: string;

  /**
   * The commit the ref will point at.
   */
  sha: string;

  /**
   * What the ref points at on the remote now. Unset for a new ref.
   */
  oldSha?: string;

  /**
   * Whether the remote's current commit is an ancestor of `sha`. A push that
   * is not one is rejected.
   */
  fastForward: boolean;

  /**
   * The commits the remote does not have yet, newest first. A push of more
   * than 500 is refused before the policy runs.
   */
  commits: { sha: string; author: string; subject: string }[];

  /**
   * Every path those commits touch.
   */
  paths: string[];

  /**
   * The text of those commits' changes, for scanning.
   */
  patch: () => Promise<string>;

  /**
   * The same paths as `paths`, with each file's content before and after the
   * push, read only when asked. Use it for checks that need the whole file,
   * such as the `scripts` of a `package.json` or the size of a binary.
   */
  files: GitPushFile[];
}

/**
 * One file as it is at a point of the push. A file is read whole, up to 8 MiB;
 * a bigger one, or a submodule, makes the read throw, which fails the push.
 */
export interface GitPushBlob {
  /**
   * Size in bytes.
   */
  size: number;

  /**
   * Whether it looks binary: a NUL byte in its first 8000 bytes, as git
   * decides when it has no attributes. `.gitattributes` are not consulted.
   */
  binary: boolean;

  /**
   * The content.
   */
  bytes: Uint8Array;

  /**
   * The git file mode where it is known: with the host's git for both sides of
   * a change, and on the API transport for the file after the push (the file
   * before has none there). One of `100644`, `100755`
   * (executable) or `120000` (a symlink, whose content is the link's target).
   * With the host's git, a change of mode alone shows in `before.mode` and
   * `after.mode`; on the API transport only `after.mode` is known.
   */
  mode?: string;

  /**
   * The content as UTF-8 text, or `undefined` for a binary file or one that
   * is not valid UTF-8. A leading byte order mark is kept.
   */
  text: string | undefined;
}

/**
 * A path a push touches, with its content before and after. The "before" is
 * the file where the push forks from what the remote has (the common ancestor
 * with the remote's tip, so for a push that is not a fast-forward it is the
 * fork point, not the tip); the "after" is the file in the pushed commit. A
 * path that is no file there, such as one the push adds or deletes, resolves
 * to `undefined`. Each is read from the host's copy of the bundle on
 * first use and kept, so a policy may call them freely.
 */
export interface GitPushFile {
  /**
   * The path, relative to the repository root.
   */
  path: string;

  /**
   * The file before the push, or `undefined` when it did not exist.
   */
  before: () => Promise<GitPushBlob | undefined>;

  /**
   * The file after the push, or `undefined` when the push deletes it.
   */
  after: () => Promise<GitPushBlob | undefined>;
}

/**
 * The largest file a policy may read. A bundle is small, but git compresses
 * well, so a file may be far bigger than the bundle that carries it.
 */
const maxFileBytes = 8 * 1024 * 1024;

let reading = 0;
const waiting: (() => void)[] = [];

/**
 * Runs `load` once, on the first call.
 */
export const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loaded: Promise<T> | undefined;

  return () => {
    loaded ??= load();

    return loaded;
  };
};

/**
 * Runs `fn` with at most four reads in flight, so a policy that reads every
 * file at once does not start a git process for each.
 */
const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
  while (reading >= 4) {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }

  reading++;

  try {
    return await fn();
  } finally {
    reading--;
    waiting.shift()?.();
  }
};

/**
 * A file's content as a policy reads it.
 */
export const blobOf = (bytes: Uint8Array): GitPushBlob => {
  const binary = bytes.subarray(0, 8000).includes(0);
  let text: string | undefined;
  if (!binary) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {}
  }

  return { size: bytes.length, binary, bytes, text };
};

/**
 * The largest file a policy may read, as the error says.
 */
export const maxPolicyFileBytes = maxFileBytes;

/**
 * Reads the file at `rev:path` in the repository at `repo`: `undefined` when
 * the path is not a file in that commit, and an error when git cannot say
 * (a corrupt or missing object, a submodule, a file too big to read).
 * @param repo The repository directory.
 * @param rev A commit, or `undefined` when there is none.
 * @param path The path in that commit.
 */
const readBlob = (
  repo: string,
  rev: string | undefined,
  path: string,
): Promise<GitPushBlob | undefined> => {
  return limited(async () => {
    if (rev === undefined) {
      return undefined;
    }

    const entry = ok(
      await hostGit(["--literal-pathspecs", "ls-tree", "-z", rev, "--", path], {
        cwd: repo,
      }),
      `looking up ${path}`,
    ).split("\0")[0];
    if (!entry) {
      return undefined;
    }

    // The path follows the first tab and may itself hold tabs.
    const tab = entry.indexOf("\t");
    const meta = entry.slice(0, tab);
    const name = entry.slice(tab + 1);
    const [mode = "", type = "", sha = ""] = meta.split(" ");
    if (name !== path || type === "tree") {
      return undefined;
    }

    if (type !== "blob") {
      throw new Error(
        `${path} is a ${type === "commit" ? "submodule" : type}, which a policy can't read`,
      );
    }

    const size = Number(
      ok(
        await hostGit(["cat-file", "-s", sha], { cwd: repo }),
        "sizing a file",
      ),
    );
    if (!(size <= maxFileBytes)) {
      throw new Error(
        `${path} is ${size} bytes, more than the ${maxFileBytes} a policy can read`,
      );
    }

    const read = await hostGit(["cat-file", "blob", sha], {
      cwd: repo,
      bytesOnly: true,
    });
    ok(read, `reading ${path}`);

    const raw = read.stdoutBytes;

    return {
      ...blobOf(new Uint8Array(raw.buffer, raw.byteOffset, raw.length)),
      mode,
    };
  });
};

/**
 * What a policy decides: nothing allows the push, `{ refuse }` stops it with a
 * message for whoever asked for the push, and `{ ref }` pushes to another ref
 * instead. A policy that allows the push, or moves it, may add `notes`: lines
 * that come back with the result (`PushedRef.notes`) for an audit trail,
 * since anything the policy did as a side effect is lost when the push step
 * replays.
 */
export type GitPolicyResult =
  | { refuse: string }
  | { ref?: string; notes?: string[] }
  | undefined
  // biome-ignore lint/suspicious/noConfusingVoidType: a policy that returns nothing has the type void
  | void;

/**
 * Decides each push of the git push tool before it happens. It receives the
 * push and answers with a `GitPolicyResult`; it may be async.
 *
 * @example
 * ```ts
 * const policy: GitPolicy = (push) => {
 *   if (!push.branch?.startsWith("agent/")) {
 *     return { refuse: "Branches for the agent start with agent/" };
 *   }
 * };
 * ```
 */
export type GitPolicy = (
  push: GitPush,
) => GitPolicyResult | Promise<GitPolicyResult>;

export type GitRun = {
  exitCode: number;
  stdout: string;
  stderr: string;

  /**
   * Standard output as bytes, for content that is not text.
   */
  stdoutBytes: Buffer;
};

/**
 * The authorization for the remote: a header for the host's git, and the
 * strings that must never appear in anything shown to anyone.
 */
export interface GitAuth {
  header: string;
  mask: string[];
}

export const maskSecrets = (text: string, secrets: string[]): string => {
  return secrets.reduce((out, secret) => {
    return out.split(secret).join("***");
  }, text);
};

/**
 * The result of a command, or an error that names `what` and carries the
 * start of stderr, with `secrets` masked.
 */
export const ok = (result: GitRun, what: string, secrets: string[] = []) => {
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `${what} failed (${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`,
        secrets,
      ),
    );
  }

  return result.stdout;
};

export const normalizeUrl = (url: string): string => {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
};

const refPattern = /^refs\/(heads|tags)\/[A-Za-z0-9._/@+-]+$/;

/**
 * Whether `ref` is a full branch or tag name a push may name. It is the one
 * check for every ref: the one asked for and the one a policy substitutes.
 */
export const isPushableRef = (
  /**
   * Full ref name, such as `refs/heads/agent/fix`.
   */
  ref: string,
): boolean => {
  // A name part starting with "-" would read as an option to git.
  return refPattern.test(ref) && !ref.includes("..") && !ref.includes("/-");
};

/**
 * The most new commits one push may carry. A longer push would be only partly
 * visible to the policy.
 */
export const maxPushCommits = 500;

/**
 * Makes the authorization for one operation on the remote.
 */
export const gitAuth = async (
  /**
   * Called each time, so a short-lived token is fresh.
   */
  token: () => string | Promise<string>,

  /**
   * Defaults to `x-access-token`, which GitHub accepts.
   */
  username = "x-access-token",
): Promise<GitAuth> => {
  const secret = await token();
  const basic = Buffer.from(`${username}:${secret}`).toString("base64");

  return {
    header: `Authorization: Basic ${basic}`,
    mask: [secret, basic].filter((value) => {
      return value !== "";
    }),
  };
};

let hostGitChecked: Promise<void> | undefined;

/**
 * Fails with an actionable error when the host has no `git`. A success is
 * remembered for the process, so a push finds out before it does any work.
 */
export const assertHostGit = (): Promise<void> => {
  hostGitChecked ??= hostGit(["--version"]).then(
    (result) => {
      ok(result, "git --version");
    },
    (error) => {
      hostGitChecked = undefined;

      throw new Error(
        `git_push needs \`git\` on the machine that runs your app, and could not run it: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

  return hostGitChecked;
};

/**
 * Runs the host's git. The token travels in the environment of that one
 * process, as a header, so it is neither in the arguments nor in any file.
 */
export const hostGit = async (
  args: string[],
  options: {
    cwd?: string;
    header?: string;
    input?: string;
    signal?: AbortSignal;

    /**
     * Skip building the text of stdout, for content read as bytes.
     */
    bytesOnly?: boolean;
  } = {},
): Promise<GitRun> => {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    const child = spawn("git", args, {
      cwd: options.cwd,
      signal: options.signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(options.header && {
          GIT_CONFIG_COUNT: String(count + 1),
          [`GIT_CONFIG_KEY_${count}`]: "http.extraHeader",
          [`GIT_CONFIG_VALUE_${count}`]: options.header,
        }),
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const take = (into: Buffer[]) => {
      return (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) {
          child.kill();
          reject(new Error("git printed more than 64 MiB"));

          return;
        }

        into.push(chunk);
      };
    };

    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBytes = Buffer.concat(out);

      resolve({
        exitCode: code ?? 1,
        stdoutBytes,
        stdout: options.bytesOnly ? "" : stdoutBytes.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    // Git may exit before it reads all of a large input.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
};

/**
 * Runs `fn` in a fresh temporary directory on the host, removed afterwards.
 */
export const withTemp = async <T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "inngest-git-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * One ref the push updated, or declined to.
 */
export interface PushedRef {
  /**
   * The ref in the bundle that was pushed.
   */
  src: string;

  /**
   * The ref it now has on the remote. The policy may have changed it from the
   * one asked for.
   */
  ref: string;
  sha: string;
  oldSha?: string;

  /**
   * `"pushed"`, or `"non-fast-forward"` when the remote has commits the push
   * lacks (nothing was sent).
   */
  status: "pushed" | "non-fast-forward";

  /**
   * Whether `ref` is the one that was asked for.
   */
  asked: boolean;

  /**
   * The notes the policy returned, if any.
   */
  notes?: string[];

  /**
   * Set when a push without git rebuilt the commits and the remote's tip
   * differs from the sandbox's: the sandbox's tip. The sandbox's branch does
   * not contain the remote's commits, so it needs a fresh clone or fetch before
   * the next push.
   */
  sandboxSha?: string;
}

const maxNotes = 20;
const maxNoteChars = 500;

/**
 * Reads what a policy returned: a refusal, or the ref to push to and the
 * notes to keep. An invalid ref or malformed notes throw, which fails the push.
 */
export const readVerdict = (
  decision: GitPolicyResult,
  asked: string,
): { refuse: string } | { ref: string; notes: string[] } => {
  const verdict = decision as Exclude<GitPolicyResult, void>;

  if (verdict && "refuse" in verdict) {
    return { refuse: verdict.refuse };
  }

  const ref = verdict?.ref ?? asked;

  if (!isPushableRef(ref)) {
    throw new Error(`The policy named an invalid ref: ${ref}`);
  }

  const notes = verdict?.notes ?? [];

  if (
    !Array.isArray(notes) ||
    notes.length > maxNotes ||
    notes.some((note) => {
      return typeof note !== "string" || note.length > maxNoteChars;
    })
  ) {
    throw new Error(
      `The policy's notes must be at most ${maxNotes} strings of at most ${maxNoteChars} characters`,
    );
  }

  return { ref, notes };
};

export type PushOutcome =
  | { pushed: PushedRef[] }
  | { refused: string }
  | { failed: string };

export interface PushBundleOptions {
  remote: string;
  auth: GitAuth;

  /**
   * The bytes of `git bundle create` for the refs in `targets`.
   */
  bundle: Uint8Array;

  /**
   * `src` is a full ref name in the bundle and `dst` the full ref to update on
   * the remote.
   */
  targets: { src: string; dst: string }[];
  policy?: GitPolicy;
  signal?: AbortSignal;
}

/**
 * Checks a bundle against the remote and the policy, and pushes it. A refusal
 * (the policy's, or a rule here) and a failure of the push itself come back as
 * data; only a broken bundle or an unreadable remote throws.
 */
export const pushBundle = async (
  options: PushBundleOptions,
): Promise<PushOutcome> => {
  const { remote, auth, bundle, targets, policy, signal } = options;

  return withTemp<PushOutcome>(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const repo = join(dir, "repo.git");

    await writeFile(join(dir, "push.bundle"), bundle);
    ok(await hostGit(["init", "--bare", "--quiet", repo]), "init");
    const unbundled = ok(
      await hostGit(["bundle", "unbundle", join(dir, "push.bundle")], {
        cwd: repo,
      }),
      "unbundling",
    );
    const shas = new Map(
      unbundled
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", ref = ""] = line.split(" ");

          return [ref, sha] as const;
        }),
    );

    // What the remote has: tips by ref, and the ones this copy knows.
    const advertised = ok(
      await hostGit(["ls-remote", "--", remote], {
        header: auth.header,
        signal,
      }),
      "listing the remote",
      auth.mask,
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", ref = ""] = line.split("\t");

        return { sha, ref };
      });
    const known = [
      ...new Set(
        advertised
          .map((entry) => {
            return entry.sha;
          })
          .filter((sha) => {
            return /^[0-9a-f]{40,64}$/.test(sha);
          }),
      ),
    ];
    const present = new Set<string>(
      (
        await hostGit(
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          { cwd: repo, input: `${known.join("\n")}\n` },
        )
      ).stdout
        .split("\n")
        .filter((line) => {
          return line.endsWith(" commit");
        })
        .map((line) => {
          return line.split(" ")[0] as string;
        }),
    );
    const pushed: PushedRef[] = [];

    for (const target of targets) {
      const sha = shas.get(target.src);
      if (!sha) {
        throw new Error(`The bundle has no ${target.src}`);
      }

      const oldSha = advertised.find((entry) => {
        return entry.ref === target.dst;
      })?.sha;
      const revs = `${sha}\n${[...present]
        .map((have) => {
          return `^${have}`;
        })
        .join("\n")}\n`;
      const listing = await hostGit(
        [
          "-c",
          "core.quotePath=false",
          "log",
          "--stdin",
          "-m",
          "--no-renames",
          "-n",
          String(maxPushCommits + 1),
          "--name-only",
          "--format=%x00%H%x1f%an%x1f%s",
        ],
        { cwd: repo, input: revs },
      );
      // Git doesn't say what it skipped when the history can't be read.
      if (listing.exitCode !== 0) {
        return { refused: "this push's history couldn't be read" };
      }

      const commits: GitPush["commits"] = [];
      const paths = new Set<string>();
      for (const record of listing.stdout.split("\0").slice(1)) {
        const [head = "", ...files] = record.split("\n");
        const [commit = "", author = "", ...subject] = head.split("\x1f");

        commits.push({ sha: commit, author, subject: subject.join("\x1f") });
        for (const file of files) {
          if (file !== "") {
            paths.add(file);
          }
        }
      }

      // The policy would see only part of a longer push, or a path that git
      // printed in quotes, so neither is pushed.
      if (commits.length > maxPushCommits) {
        return {
          refused: `a push may have at most ${maxPushCommits} new commits`,
        };
      }

      if (
        [...paths].some((path) => {
          return path.startsWith('"');
        })
      ) {
        return {
          refused: "a path in this push has characters git_push can't check",
        };
      }

      const fastForward =
        oldSha === undefined ||
        (
          await hostGit(["merge-base", "--is-ancestor", oldSha, sha], {
            cwd: repo,
          })
        ).exitCode === 0;
      let ref = target.dst;
      let notes: string[] = [];

      if (policy) {
        // The file before the push is the file where this push forks from the
        // history the remote has: the common ancestor with the remote's tip,
        // or for a new ref with the commits the remote is known to hold.
        const base = once(async () => {
          const others =
            oldSha !== undefined && present.has(oldSha)
              ? [oldSha]
              : [...present];
          if (others.length === 0) {
            return undefined;
          }

          const found = await hostGit(["merge-base", sha, ...others], {
            cwd: repo,
          });
          // Exit 1 is "no common ancestor": everything the push touches is new.
          if (found.exitCode === 1) {
            return undefined;
          }

          return ok(found, "finding where the push forks").split("\n")[0];
        });
        const files: GitPushFile[] = [...paths].sort().map((path) => {
          return {
            path,
            before: once(async () => {
              return readBlob(repo, await base(), path);
            }),
            after: once(async () => {
              return readBlob(repo, sha, path);
            }),
          };
        });
        const decision = await policy({
          remote,
          ref,
          ...(ref.startsWith("refs/heads/") && {
            branch: ref.slice("refs/heads/".length),
          }),
          sha,
          ...(oldSha !== undefined && { oldSha }),
          fastForward,
          commits,
          paths: [...paths].sort(),
          files,
          patch: async () => {
            const printed = await hostGit(
              [
                "-c",
                "core.quotePath=false",
                "log",
                "--stdin",
                "-m",
                "-p",
                "--binary",
                "--no-renames",
                "-n",
                String(maxPushCommits + 1),
                "--format=%H %s",
              ],
              { cwd: repo, input: revs },
            );
            if (printed.exitCode !== 0) {
              throw new Error("the history of this push couldn't be read");
            }

            return printed.stdout;
          },
        });
        const verdict = readVerdict(decision, ref);

        if ("refuse" in verdict) {
          return { refused: verdict.refuse };
        }

        ref = verdict.ref;
        notes = verdict.notes;
      }

      const asked = ref === target.dst;

      if (!fastForward && asked) {
        pushed.push({
          src: target.src,
          ref,
          sha,
          ...(oldSha !== undefined && { oldSha }),
          status: "non-fast-forward",
          asked,
          ...(notes.length > 0 && { notes }),
        });
        continue;
      }

      const sent = await hostGit(
        ["push", "--porcelain", "--", remote, `${sha}:${ref}`],
        { cwd: repo, header: auth.header, signal },
      );
      if (sent.exitCode !== 0) {
        return {
          failed: maskSecrets(`${sent.stderr}${sent.stdout}`.trim(), auth.mask),
        };
      }

      pushed.push({
        src: target.src,
        ref,
        sha,
        ...(oldSha !== undefined && { oldSha }),
        status: "pushed",
        asked,
        ...(notes.length > 0 && { notes }),
      });
    }

    return { pushed };
  });
};
