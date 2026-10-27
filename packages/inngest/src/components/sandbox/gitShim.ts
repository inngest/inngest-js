/**
 * @module
 * EXPERIMENTAL: The `git` action shim (`tool.shim.git()`). Code in the sandbox
 * runs `git clone`, `git fetch` and `git push` as usual, and each one is done
 * by your app instead: a clone or fetch happens on the host and its objects
 * are unpacked into the sandbox, and a push is bundled in the sandbox, brought
 * home, checked by your policy and pushed from the host. The token lives only
 * in your app, so there is nothing in the sandbox to print or copy.
 *
 * The host needs `git` and `tar`. Every other git command runs the real git in
 * the sandbox, with no round trip to your app.
 */
import type { ShimCall, ShimDefinition, ShimResult } from "./shims.ts";
import type { Sandbox } from "./types.ts";
import { SandboxValidationError } from "./types.ts";

const defaultMaxBytes = 128 * 1024 * 1024;

/**
 * The words the shim answers for. Any other call runs the real git.
 */
const handledWords = ["clone", "fetch", "pull", "push"];

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
}

/**
 * What a policy decides: nothing allows the push, `{ refuse }` stops it with a
 * message for the code that ran `git push`, and `{ ref }` pushes to another
 * ref instead.
 */
export type GitPolicyResult =
  | { refuse: string }
  | { ref: string }
  | undefined
  // biome-ignore lint/suspicious/noConfusingVoidType: a policy that returns nothing has the type void
  | void;

export interface GitShimOptions {
  /**
   * The repository, as the host reaches it. Code in the sandbox sees it as
   * `origin`, and `git clone` accepts only this URL.
   */
  remote: string;

  /**
   * Makes the token for one operation on the remote. Called on the host each
   * time a clone, fetch or push reaches the remote, and never sent to the
   * sandbox.
   */
  token: () => string | Promise<string>;

  /**
   * The user name that goes with the token. Defaults to `x-access-token`,
   * which GitHub accepts for app and OAuth tokens.
   */
  username?: string;

  /**
   * Decides each push before it happens. Without one every push is allowed.
   */
  policy?: (push: GitPush) => GitPolicyResult | Promise<GitPolicyResult>;

  /**
   * The most a bundle, or a clone sent to the sandbox, may weigh in bytes.
   * Defaults to 128 MiB.
   */
  maxBytes?: number;
}

type Run = { exitCode: number; stdout: string; stderr: string };

const maskSecrets = (text: string, secrets: string[]): string => {
  return secrets.reduce((out, secret) => {
    return out.split(secret).join("***");
  }, text);
};

const ok = (result: Run, what: string, secrets: string[] = []): string => {
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

const normalizeUrl = (url: string): string => {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
};

const refPattern = /^refs\/(heads|tags)\/[A-Za-z0-9._/@+-]+$/;

/**
 * Where `git -C <dir>` options and the subcommand are in `argv`.
 */
const splitGlobal = (
  argv: string[],
  cwd: string,
): { cwd: string; rest: string[] } => {
  let dir = cwd;
  let at = 0;

  while (argv[at] === "-C" && argv[at + 1] !== undefined) {
    dir = (argv[at + 1] as string).startsWith("/")
      ? (argv[at + 1] as string)
      : `${dir.replace(/\/$/, "")}/${argv[at + 1]}`;
    at += 2;
  }

  return { cwd: dir, rest: argv.slice(at) };
};

type PushOutcome =
  | { results: string[] }
  | { refused: string }
  | { failed: string };

const unsupported = (what: string): string => {
  return `${what} isn't supported through the host. Supported: clone [--depth N] [-b BRANCH] <url> [dir], fetch, push [remote] [src[:dst]]`;
};

/**
 * Splits `args` into flags and positionals, with the values flags take.
 */
const parseArgs = (
  args: string[],
  allowed: { flags: string[]; withValue: string[] },
): { positional: string[]; values: Record<string, string> } | string => {
  const positional: string[] = [];
  const values: Record<string, string> = {};

  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    const [name = "", inline] = arg.startsWith("--")
      ? arg.split(/=(.*)/s)
      : [arg];

    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
    } else if (allowed.withValue.includes(name)) {
      const value = inline ?? args[++at];
      if (value === undefined) {
        return `${name} needs a value`;
      }

      values[name] = value;
    } else if (allowed.flags.includes(name) && inline === undefined) {
      values[name] = "";
    } else {
      return unsupported(name);
    }
  }

  return { positional, values };
};

const sandboxRun = async (
  sandbox: Sandbox,
  argv: string[],
  cwd?: string,
): Promise<Run> => {
  const result = await sandbox.commands.run(argv, cwd ? { cwd } : undefined);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/**
 * Runs the host's git. The token travels in the environment of that one
 * process, as a header, so it is neither in the arguments nor in any file.
 */
const hostGit = async (
  args: string[],
  options: {
    cwd?: string;
    header?: string;
    input?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Run> => {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      signal: options.signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(options.header && {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: options.header,
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
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    // Git may exit before it reads all of a large input.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
};

const hostTar = async (args: string[], input?: Uint8Array) => {
  const { spawn } = await import("node:child_process");

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("tar", args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new Error(
            `tar failed: ${Buffer.concat(err).toString().slice(0, 300)}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
};

/**
 * The definition behind `tool.shim.git()`.
 */
export const gitShimDefinition = (options: GitShimOptions): ShimDefinition => {
  if (
    typeof options?.remote !== "string" ||
    options.remote === "" ||
    options.remote.startsWith("-")
  ) {
    throw new SandboxValidationError("tool.shim.git needs a remote URL");
  }

  // The URL is shown to the sandbox, so it must carry no credential.
  let parsedRemote: URL | undefined;
  try {
    parsedRemote = new URL(options.remote);
  } catch {}

  if (
    !parsedRemote ||
    !["https:", "http:"].includes(parsedRemote.protocol) ||
    parsedRemote.username !== "" ||
    parsedRemote.password !== ""
  ) {
    throw new SandboxValidationError(
      "tool.shim.git needs an http(s) remote URL without a user name or password; give the token in token",
    );
  }

  if (typeof options.token !== "function") {
    throw new SandboxValidationError("tool.shim.git needs a token function");
  }

  if (options.policy !== undefined && typeof options.policy !== "function") {
    throw new SandboxValidationError("policy must be a function");
  }

  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new SandboxValidationError("maxBytes must be a whole number from 1");
  }

  const { remote, policy } = options;
  const username = options.username ?? "x-access-token";

  const authHeader = async (): Promise<{ header: string; mask: string[] }> => {
    const token = await options.token();
    const basic = Buffer.from(`${username}:${token}`).toString("base64");

    return {
      header: `Authorization: Basic ${basic}`,
      mask: [token, basic].filter((value) => {
        return value !== "";
      }),
    };
  };

  const masked = maskSecrets;

  const withTemp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
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
   * Where scratch files for one call live in the sandbox. A retry of the call
   * gets the same path.
   */
  const scratchPath = async (key: string, name: string): Promise<string> => {
    const { createHash } = await import("node:crypto");

    return `/tmp/inngest-git-${createHash("sha256").update(key).digest("hex").slice(0, 16)}-${name}`;
  };

  /**
   * Clones the remote on the host and unpacks it in the sandbox as a bare
   * repository at `target`. A `fetch` of that repository is how the
   * sandbox's own clone receives it.
   */
  const sendRepo = async (
    call: ShimCall,
    target: string,
    cloneArgs: string[],
  ): Promise<void> => {
    const auth = await authHeader();

    await withTemp(async (dir) => {
      const cloned = await hostGit(
        ["clone", "--bare", "--quiet", ...cloneArgs, "--", remote, "repo.git"],
        { cwd: dir, header: auth.header, signal: call.signal },
      );
      if (cloned.exitCode !== 0) {
        throw new Error(
          masked(`clone failed: ${cloned.stderr.trim()}`, auth.mask).slice(
            0,
            500,
          ),
        );
      }

      const tar = await hostTar(["-cf", "-", "-C", dir, "repo.git"]);
      if (tar.length > maxBytes) {
        throw new Error(
          `The repository is ${tar.length} bytes, more than maxBytes (${maxBytes})`,
        );
      }

      const archive = await scratchPath(call.idempotencyKey, "repo.tar");
      try {
        await call.sandbox.files.upload({
          path: archive,
          data: new Uint8Array(tar),
        });
        ok(
          await sandboxRun(call.sandbox, [
            "/bin/sh",
            "-c",
            'rm -rf "$1" && mkdir -p "$1" && tar -xf "$2" -C "$1"',
            "sh",
            target,
            archive,
          ]),
          "unpacking the repository",
        );
      } finally {
        await sandboxRun(call.sandbox, ["rm", "-f", archive]);
      }
    });
  };

  const clone = async (
    call: ShimCall,
    args: string[],
    cwd: string,
  ): Promise<ShimResult> => {
    const parsed = parseArgs(args, {
      flags: ["--quiet", "-q", "--single-branch"],
      withValue: ["--depth", "--branch", "-b"],
    });
    if (typeof parsed === "string") {
      return call.refuse(parsed);
    }

    const [url, dirArg, ...extra] = parsed.positional;
    if (url === undefined || extra.length > 0) {
      return call.refuse(unsupported("This form of clone"));
    }

    if (normalizeUrl(url) !== normalizeUrl(remote)) {
      return call.refuse(`can only clone ${remote}`);
    }

    const depth = parsed.values["--depth"];
    if (depth !== undefined && !/^[1-9][0-9]{0,8}$/.test(depth)) {
      return call.refuse("--depth needs a whole number");
    }

    const branch = parsed.values["--branch"] ?? parsed.values["-b"];
    if (
      branch !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(branch)
    ) {
      return call.refuse("that branch name isn't supported");
    }

    const dir =
      dirArg ??
      (remote
        .replace(/\/+$/, "")
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() ||
        "repo");
    const bare = await scratchPath(call.idempotencyKey, "clone");

    try {
      await sendRepo(call, bare, [
        ...(depth ? ["--depth", depth, `--no-single-branch`] : []),
        ...(branch ? ["--branch", branch] : []),
      ]);

      const result = await sandboxRun(
        call.sandbox,
        [
          "/bin/sh",
          "-c",
          'git clone --quiet --no-hardlinks "file://$1/repo.git" "$2" && git -C "$2" remote set-url origin "$3"',
          "sh",
          bare,
          dir,
          remote,
        ],
        cwd,
      );
      if (
        result.exitCode === 0 &&
        !(parsed.values["--quiet"] ?? parsed.values["-q"])
      ) {
        result.stderr = `Cloning into '${dir}'...\n${result.stderr}`;
      }

      return call.reply(result.exitCode, {
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } finally {
      await sandboxRun(call.sandbox, ["rm", "-rf", bare]);
    }
  };

  const fetch = async (
    call: ShimCall,
    args: string[],
    cwd: string,
  ): Promise<ShimResult> => {
    const parsed = parseArgs(args, {
      flags: ["--quiet", "-q", "--prune", "-p", "--tags", "-t"],
      withValue: [],
    });
    if (typeof parsed === "string") {
      return call.refuse(parsed);
    }

    const [name, ...more] = parsed.positional;
    if (more.length > 0 || (name !== undefined && name !== "origin")) {
      return call.refuse(unsupported("Fetching anything but origin"));
    }

    const bare = await scratchPath(call.idempotencyKey, "fetch");

    try {
      await sendRepo(call, bare, []);

      const result = await sandboxRun(
        call.sandbox,
        [
          "git",
          "fetch",
          "--quiet",
          ...(parsed.values["--prune"] !== undefined ||
          parsed.values["-p"] !== undefined
            ? ["--prune"]
            : []),
          `file://${bare}/repo.git`,
          "+refs/heads/*:refs/remotes/origin/*",
          "+refs/tags/*:refs/tags/*",
        ],
        cwd,
      );

      return call.reply(result.exitCode, {
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } finally {
      await sandboxRun(call.sandbox, ["rm", "-rf", bare]);
    }
  };

  /**
   * The refs to push: `[remote] [src[:dst]...]`, as full names.
   */
  const pushTargets = async (
    call: ShimCall,
    positional: string[],
    cwd: string,
  ): Promise<{ src: string; dst: string }[] | string> => {
    const [name, ...specs] = positional;
    if (
      name !== undefined &&
      name !== "origin" &&
      normalizeUrl(name) !== normalizeUrl(remote)
    ) {
      return `can only push to origin (${remote})`;
    }

    // Fails when HEAD is detached.
    const head = (
      await sandboxRun(call.sandbox, ["git", "symbolic-ref", "-q", "HEAD"], cwd)
    ).stdout.trim();
    const wanted = specs.length > 0 ? specs : [head];
    if (wanted[0] === "") {
      return "HEAD isn't on a branch; name the branch to push";
    }

    if (wanted.length > 1) {
      return unsupported("Pushing more than one ref at once");
    }

    const targets: { src: string; dst: string }[] = [];
    for (const spec of wanted) {
      if (spec.startsWith("+") || spec.startsWith(":")) {
        return unsupported("Force pushes and deleting refs");
      }

      const [srcName = "", dstName] = spec.split(":");
      const resolved = await sandboxRun(
        call.sandbox,
        ["git", "rev-parse", "--verify", "--symbolic-full-name", srcName],
        cwd,
      );
      const src = resolved.stdout.trim();
      if (resolved.exitCode !== 0 || !refPattern.test(src)) {
        return `${srcName} is not a branch or tag in this repository`;
      }

      const dst = dstName
        ? dstName.startsWith("refs/")
          ? dstName
          : `refs/heads/${dstName}`
        : src;
      if (!refPattern.test(dst)) {
        return `${dstName ?? dst} is not a branch or tag name this shim can push`;
      }

      targets.push({ src, dst });
    }

    return targets;
  };

  const push = async (
    call: ShimCall,
    args: string[],
    cwd: string,
  ): Promise<ShimResult> => {
    const parsed = parseArgs(args, {
      flags: [
        "-u",
        "--set-upstream",
        "--quiet",
        "-q",
        "--verbose",
        "-v",
        "--no-verify",
      ],
      withValue: [],
    });
    if (typeof parsed === "string") {
      return call.refuse(parsed);
    }

    const targets = await pushTargets(call, parsed.positional, cwd);
    if (typeof targets === "string") {
      return call.refuse(targets);
    }

    const auth = await authHeader();
    const bundle = await scratchPath(call.idempotencyKey, "push.bundle");
    const lines: string[] = [`To ${remote}`];

    try {
      // Everything reachable from the pushed refs, so the host can check and
      // push it without a copy of the remote.
      ok(
        await sandboxRun(
          call.sandbox,
          [
            "git",
            "bundle",
            "create",
            "--quiet",
            bundle,
            ...targets.map((target) => {
              return target.src;
            }),
          ],
          cwd,
        ),
        "bundling",
      );

      const size = Number(
        ok(
          await sandboxRun(call.sandbox, [
            "/bin/sh",
            "-c",
            'wc -c < "$1"',
            "sh",
            bundle,
          ]),
          "measuring the bundle",
        ).trim(),
      );
      if (!(size <= maxBytes)) {
        return call.refuse(
          `the push is ${size} bytes, more than the ${maxBytes} this shim accepts`,
        );
      }

      const data = new Uint8Array(
        await (
          await call.sandbox.files.download({ path: bundle })
        ).arrayBuffer(),
      );
      // The file may have changed since it was measured.
      if (data.byteLength > maxBytes) {
        return call.refuse(
          `the push is more than the ${maxBytes} bytes this shim accepts`,
        );
      }

      const outcome: PushOutcome = await withTemp<PushOutcome>(async (dir) => {
        const { writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const repo = join(dir, "repo.git");

        await writeFile(join(dir, "push.bundle"), data);
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
            signal: call.signal,
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
              {
                cwd: repo,
                input: `${known.join("\n")}\n`,
              },
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
        const results: string[] = [];

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
          const listed = (
            await hostGit(
              [
                "-c",
                "core.quotePath=false",
                "log",
                "--stdin",
                "-m",
                "--no-renames",
                "-n",
                "501",
                "--name-only",
                "--format=%x01%H%x1f%an%x1f%s",
              ],
              { cwd: repo, input: revs },
            )
          ).stdout;
          const commits: GitPush["commits"] = [];
          const paths = new Set<string>();
          for (const record of listed.split("\x01").slice(1)) {
            const [head = "", ...files] = record.split("\n");
            const [commit = "", author = "", subject = ""] = head.split("\x1f");

            commits.push({ sha: commit, author, subject });
            for (const file of files) {
              if (file !== "") {
                paths.add(file);
              }
            }
          }

          // The policy would see only part of a longer push, or a path that git
          // printed in quotes, so neither is pushed.
          if (commits.length > 500) {
            return { refused: "a push may have at most 500 new commits" };
          }

          if (
            [...paths].some((path) => {
              return path.startsWith('"');
            })
          ) {
            return {
              refused:
                "a path in this push has characters this shim can't check",
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
          if (policy) {
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
              patch: async () => {
                return (
                  await hostGit(
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
                      "501",
                      "--format=%H %s",
                    ],
                    { cwd: repo, input: revs },
                  )
                ).stdout;
              },
            });
            const verdict = decision as Exclude<GitPolicyResult, void>;
            if (verdict && "refuse" in verdict) {
              return { refused: verdict.refuse };
            }

            if (verdict && "ref" in verdict) {
              if (!refPattern.test(verdict.ref)) {
                throw new Error(
                  `The policy named an invalid ref: ${verdict.ref}`,
                );
              }

              ref = verdict.ref;
            }
          }

          if (!fastForward && ref === target.dst) {
            results.push(
              `! [rejected]        ${target.src} -> ${ref} (non-fast-forward)`,
            );
            continue;
          }

          const pushed = await hostGit(
            ["push", "--porcelain", "--", remote, `${sha}:${ref}`],
            { cwd: repo, header: auth.header, signal: call.signal },
          );
          if (pushed.exitCode !== 0) {
            return {
              failed: masked(
                `${pushed.stderr}${pushed.stdout}`.trim(),
                auth.mask,
              ),
            };
          }

          results.push(
            oldSha === undefined || ref !== target.dst
              ? `* [new ${ref.startsWith("refs/tags/") ? "tag" : "branch"}]      ${target.src} -> ${ref}`
              : `   ${oldSha.slice(0, 7)}..${sha.slice(0, 7)}  ${target.src} -> ${ref}`,
          );
          if (ref === target.dst && ref.startsWith("refs/heads/")) {
            const branch = ref.slice("refs/heads/".length);
            await sandboxRun(
              call.sandbox,
              ["git", "update-ref", `refs/remotes/origin/${branch}`, sha],
              cwd,
            );

            if (
              (parsed.values["-u"] ?? parsed.values["--set-upstream"]) !==
                undefined &&
              target.src.startsWith("refs/heads/")
            ) {
              await sandboxRun(
                call.sandbox,
                [
                  "git",
                  "branch",
                  `--set-upstream-to=origin/${branch}`,
                  target.src.slice("refs/heads/".length),
                ],
                cwd,
              );
            }
          }
        }

        return { results };
      });

      if ("refused" in outcome) {
        return call.refuse(outcome.refused);
      }

      if ("failed" in outcome) {
        return call.reply(1, { stderr: `${outcome.failed}\n` });
      }

      lines.push(...outcome.results);
      const rejected = outcome.results.some((line) => {
        return line.startsWith("!");
      });

      return call.reply(rejected ? 1 : 0, { stderr: `${lines.join("\n")}\n` });
    } finally {
      await sandboxRun(call.sandbox, ["rm", "-f", bundle]);
    }
  };

  return {
    description:
      "clone, fetch and push are done by the host, which holds the credentials; other commands run in the sandbox",
    only: handledWords,
    handle: async (call) => {
      const { cwd, rest } = splitGlobal(call.argv, call.cwd);
      const [word, ...args] = rest;

      switch (word) {
        case "clone":
          return clone(call, args, cwd);
        case "fetch":
          return fetch(call, args, cwd);
        case "push":
          return push(call, args, cwd);
        case "pull":
          return call.refuse(
            "use git fetch and git merge, since pull isn't supported through the host",
          );
        default:
          return call.run();
      }
    },
  };
};
