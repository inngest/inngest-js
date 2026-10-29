/**
 * @module
 * Tests for the git-free push: the manifest script runs for real in a git
 * repository, and `pushManifest()` rebuilds its commits on a fake GitHub API
 * that keeps blobs, trees, commits and refs in memory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NonRetriableError } from "../NonRetriableError.ts";
import { fakeGitHub } from "./git-fixtures/githubFake.ts";
import {
  commitFiles,
  isApiRemote,
  isGitHubRemote,
  isPlainPath,
  manifestScript,
  parseManifest,
  pushManifest,
  remoteState,
} from "./gitApi.ts";
import type { GitPolicy } from "./gitPush.ts";

const token = "ghs_api_secret_token_value";
const remote = "https://github.com/acme/app";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
};

describe("the git-free push", { timeout: 60_000 }, () => {
  let work: string;
  let base: string;
  let hub: ReturnType<typeof fakeGitHub>;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "git-api-work-"));
    git(work, "init", "--quiet", "-b", "main");
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(work, "old.txt"), "to delete\n");
    writeFileSync(join(work, "keep.txt"), "keep\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "base");
    base = git(work, "rev-parse", "HEAD");
    hub = fakeGitHub();
    hub.seed(work, base, "refs/heads/main");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * Makes the sandbox's commits on a branch off the base.
   */
  const branch = (name: string, edit: () => void, message = "edit") => {
    git(work, "checkout", "--quiet", "-B", name, base);
    edit();
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
  };

  const manifestOf = (tip: string, from = base): string => {
    const out = join(work, ".manifest");
    const ran = spawnSync("sh", ["-c", manifestScript, "sh", from, tip, out], {
      cwd: work,
      env,
      encoding: "utf8",
    });

    expect(ran.status).toBe(0);

    return readFileSync(out, "utf8");
  };

  const push = async (
    name: string,
    policy?: GitPolicy,
    over: { from?: string; tip?: string } = {},
  ) => {
    const ref = `refs/heads/${name}`;
    const tip = over.tip ?? git(work, "rev-parse", ref);
    const state = await remoteState({
      remote,
      ref,
      token,
      fetch: hub.handle,
    });

    return pushManifest({
      remote,
      token,
      fetch: hub.handle,
      manifest: manifestOf(tip, over.from ?? state.base),
      target: { src: ref, dst: ref },
      tip,
      state,
      policy,
    });
  };

  /**
   * The files of a tree in the fake, as path to mode and content.
   */
  const filesAt = (commit: string): Record<string, string> => {
    const tree = hub.trees.get(hub.commits.get(commit)?.tree ?? "");

    return Object.fromEntries(
      [...(tree ?? [])].map(([path, entry]) => {
        return [
          path,
          `${entry.mode} ${Buffer.from(hub.blobs.get(entry.sha) as Uint8Array).toString("base64")}`,
        ];
      }),
    );
  };

  /**
   * The same listing, from the real repository.
   */
  const realFilesAt = (commit: string): Record<string, string> => {
    const out: Record<string, string> = {};

    for (const line of git(work, "ls-tree", "-r", commit).split("\n")) {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "", , sha = ""] = meta.split(" ");

      out[path] =
        `${mode} ${execFileSync("git", ["cat-file", "blob", sha], { cwd: work, env, maxBuffer: 64 * 1024 * 1024 }).toString("base64")}`;
    }

    return out;
  };

  test("rebuilds the commits on the remote: edits, deletes, a binary file, a mode change, an empty file", async () => {
    branch(
      "agent/big",
      () => {
        writeFileSync(join(work, "src/a.ts"), "export const a = 2;\n");
        git(work, "rm", "--quiet", "old.txt");
        writeFileSync(
          join(work, "blob.bin"),
          Buffer.from([0, 1, 2, 255, 0, 7]),
        );
        writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
        chmodSync(join(work, "run.sh"), 0o755);
        writeFileSync(join(work, "empty.txt"), "");
      },
      "first change\n\nwith a body",
    );
    writeFileSync(join(work, "keep.txt"), "kept, edited\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "second change");

    const outcome = await push("agent/big");

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/big", status: "pushed", asked: true }],
    });

    const pushed = (outcome as { pushed: { sha: string }[] }).pushed[0];
    const made = hub.commits.get(pushed?.sha ?? "");

    expect(hub.refs.get("refs/heads/agent/big")).toBe(pushed?.sha);
    expect(filesAt(pushed?.sha ?? "")).toEqual(
      realFilesAt(git(work, "rev-parse", "refs/heads/agent/big")),
    );
    expect(made?.message).toBe("second change\n");
    expect(pushed?.sha).toBe(git(work, "rev-parse", "refs/heads/agent/big"));
    expect(made?.author).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
    });

    const parent = hub.commits.get(made?.parents[0] ?? "");

    expect(parent?.message).toBe("first change\n\nwith a body\n");
    expect(parent?.parents).toEqual([base]);
  });

  test("a push of many files sends text inside the trees and uploads only the rest, together", async () => {
    branch("agent/many", () => {
      for (let n = 0; n < 12; n += 1) {
        writeFileSync(join(work, `text-${n}.txt`), `file ${n}\n`);
      }

      for (let n = 0; n < 6; n += 1) {
        writeFileSync(join(work, `bin-${n}.bin`), Buffer.from([0, n, 255, 7]));
      }

      writeFileSync(join(work, "same-a.bin"), Buffer.from([9, 0, 9]));
      writeFileSync(join(work, "same-b.bin"), Buffer.from([9, 0, 9]));
      writeFileSync(join(work, "empty.txt"), "");
    });

    const before = hub.requests.length;
    const outcome = await push("agent/many");
    const made = hub.requests.slice(before).filter((request) => {
      return request.method === "POST";
    });
    const count = (path: string) => {
      return made.filter((request) => {
        return request.path === path;
      }).length;
    };

    expect(outcome).toMatchObject({ pushed: [{ status: "pushed" }] });
    // Six binary files, the two equal ones as one blob, and the empty file.
    expect(count("/git/blobs")).toBe(8);
    expect(count("/git/trees")).toBe(1);
    expect(count("/git/commits")).toBe(1);

    const pushed = (outcome as { pushed: { sha: string }[] }).pushed[0];

    expect(pushed?.sha).toBe(git(work, "rev-parse", "refs/heads/agent/many"));
    expect(filesAt(pushed?.sha ?? "")).toEqual(
      realFilesAt(git(work, "rev-parse", "refs/heads/agent/many")),
    );
  });

  test("a blob whose content does not match its hash is refused before anything is sent", async () => {
    branch("agent/liar", () => {
      writeFileSync(join(work, "a.txt"), "real\n");
    });

    const tip = git(work, "rev-parse", "refs/heads/agent/liar");
    const state = await remoteState({
      remote,
      ref: "refs/heads/agent/liar",
      token,
      fetch: hub.handle,
    });
    const manifest = manifestOf(tip, state.base).replace(
      /^(BLOB [0-9a-f]{40} )(.*)$/m,
      (_line, head: string) => {
        return `${head}${Buffer.from("forged\n").toString("base64")}`;
      },
    );
    const before = hub.requests.length;
    const outcome = await pushManifest({
      remote,
      token,
      fetch: hub.handle,
      manifest,
      target: { src: "refs/heads/agent/liar", dst: "refs/heads/agent/liar" },
      tip,
      state,
    });

    expect(outcome).toMatchObject({ refused: expect.stringContaining("hash") });
    expect(
      hub.requests.slice(before).filter((request) => {
        return request.method === "POST";
      }),
    ).toEqual([]);
  });

  test("shows the policy the commits, paths and files before and after, from the manifest", async () => {
    branch("agent/p", () => {
      writeFileSync(
        join(work, "src/a.ts"),
        "export const a = 2;\nexport const b = 3;\n",
      );
      git(work, "rm", "--quiet", "old.txt");
      writeFileSync(join(work, "new.txt"), "fresh\n");
    });

    const seen: unknown[] = [];
    const outcome = await push("agent/p", async (pushed) => {
      seen.push({
        branch: pushed.branch,
        oldSha: pushed.oldSha,
        fastForward: pushed.fastForward,
        commits: pushed.commits.map((commit) => {
          return [commit.author, commit.subject];
        }),
        paths: pushed.paths,
      });

      const byPath = Object.fromEntries(
        await Promise.all(
          pushed.files.map(async (file) => {
            return [
              file.path,
              [(await file.before())?.text, (await file.after())?.text],
            ] as const;
          }),
        ),
      );

      seen.push(byPath);
      seen.push(await pushed.patch());
    });

    expect(outcome).toHaveProperty("pushed");
    expect(seen[0]).toEqual({
      branch: "agent/p",
      oldSha: undefined,
      fastForward: true,
      commits: [["Ada", "edit"]],
      paths: ["new.txt", "old.txt", "src/a.ts"],
    });
    expect(seen[1]).toEqual({
      "new.txt": [undefined, "fresh\n"],
      "old.txt": ["to delete\n", undefined],
      "src/a.ts": [
        "export const a = 1;\n",
        "export const a = 2;\nexport const b = 3;\n",
      ],
    });
    expect(seen[2]).toContain("+export const b = 3;");
    expect(seen[2]).toContain("-export const a = 1;");
    expect(seen[2]).toContain("-to delete");
    expect(seen[2]).toContain("+fresh");
  });

  test("a policy refusal pushes nothing, not even a blob", async () => {
    branch("agent/no", () => {
      mkdirSync(join(work, ".github"));
      writeFileSync(join(work, ".github/ci.yml"), "on: push\n");
    });
    hub.requests.length = 0;

    const outcome = await push("agent/no", (pushed) => {
      if (pushed.paths.some((path) => path.startsWith(".github/"))) {
        return { refuse: "do not touch .github" };
      }

      return undefined;
    });

    expect(outcome).toEqual({ refused: "do not touch .github" });
    expect(hub.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
    expect(hub.refs.has("refs/heads/agent/no")).toBe(false);
  });

  test("a policy can push to another ref instead", async () => {
    branch("agent/x", () => {
      writeFileSync(join(work, "x.txt"), "x\n");
    });

    const outcome = await push("agent/x", () => {
      return { ref: "refs/heads/agent/safe" };
    });

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/safe", asked: false }],
    });
    expect(hub.refs.has("refs/heads/agent/safe")).toBe(true);
    expect(hub.refs.has("refs/heads/agent/x")).toBe(false);
  });

  test("fast-forwards a branch that already exists, with the same commit hashes as the sandbox's", async () => {
    branch("agent/ff", () => {
      writeFileSync(join(work, "one.txt"), "1\n");
    });
    await push("agent/ff");

    expect(hub.refs.get("refs/heads/agent/ff")).toBe(
      git(work, "rev-parse", "refs/heads/agent/ff"),
    );

    writeFileSync(join(work, "two.txt"), "2\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "two");

    const outcome = await push("agent/ff");

    expect(outcome).toMatchObject({
      pushed: [{ status: "pushed", oldSha: expect.any(String) }],
    });
    expect(hub.refs.get("refs/heads/agent/ff")).toBe(
      git(work, "rev-parse", "refs/heads/agent/ff"),
    );
  });

  test("a branch that doesn't continue from the remote's is not a fast-forward", async () => {
    branch("agent/side", () => {
      writeFileSync(join(work, "s.txt"), "s\n");
    });

    // The remote's branch is a different line of history that the sandbox has.
    git(work, "checkout", "--quiet", "-B", "other", base);
    writeFileSync(join(work, "o.txt"), "o\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "other");
    hub.seed(work, git(work, "rev-parse", "other"), "refs/heads/agent/side");

    const outcome = await push("agent/side");

    expect(outcome).toMatchObject({ pushed: [{ status: "non-fast-forward" }] });
    expect(hub.refs.get("refs/heads/agent/side")).toBe(
      git(work, "rev-parse", "other"),
    );
  });

  test("a ref that moved between the check and the push is not forced", async () => {
    branch("agent/race", () => {
      writeFileSync(join(work, "r.txt"), "r\n");
    });

    const ref = "refs/heads/agent/race";

    hub.refs.set(ref, base);

    const state = await remoteState({ remote, ref, token, fetch: hub.handle });
    const other = hub.commits.get(base);

    hub.commits.set("f".repeat(40), {
      tree: other?.tree ?? "",
      parents: [base],
      message: "someone else",
      author: {},
    });
    hub.refs.set(ref, "f".repeat(40));

    const outcome = await pushManifest({
      remote,
      token,
      fetch: hub.handle,
      manifest: manifestOf(git(work, "rev-parse", ref), state.base),
      target: { src: ref, dst: ref },
      tip: git(work, "rev-parse", ref),
      state,
    });

    expect(outcome).toMatchObject({ pushed: [{ status: "non-fast-forward" }] });
    expect(hub.refs.get(ref)).toBe("f".repeat(40));
  });

  test("the token goes only in the Authorization header, and is masked in failures", async () => {
    branch("agent/fail", () => {
      writeFileSync(join(work, "f.txt"), "f\n");
    });

    const manifest = manifestOf(
      git(work, "rev-parse", "refs/heads/agent/fail"),
    );

    expect(manifest).not.toContain(token);

    hub.fail.match = /POST \/git\/trees/;
    hub.fail.status = 422;

    const outcome = await push("agent/fail");

    expect(outcome).toHaveProperty("failed");
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(JSON.stringify(outcome)).toContain("***");
    expect(
      hub.requests.every((request) => {
        return request.authorization === `Bearer ${token}`;
      }),
    ).toBe(true);
  });

  test("refuses a merge commit, a missing blob and a submodule", async () => {
    const sha = "a".repeat(40);
    const blob = "b".repeat(40);
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const header = (parents: string) => {
      return [
        `COMMIT ${sha} ${parents}`,
        `AUTHOR ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00+00:00`,
        `COMMITTER ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00+00:00`,
        `MESSAGE ${b64("m")}`,
      ];
    };
    const run = (lines: string[]) => {
      return pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${lines.join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      });
    };

    await expect(
      run(header(`${base} ${"c".repeat(40)}`)),
    ).resolves.toMatchObject({
      refused: expect.stringContaining("merge commit"),
    });
    await expect(
      run([
        ...header(base),
        `CHANGE A 000000 100644 ${"0".repeat(40)} ${blob} ${b64("f.txt")}`,
      ]),
    ).resolves.toMatchObject({
      refused: expect.stringContaining("lacks the content"),
    });
    await expect(
      run([
        ...header(base),
        `CHANGE A 000000 160000 ${"0".repeat(40)} ${blob} ${b64("sub")}`,
      ]),
    ).resolves.toMatchObject({ refused: expect.stringContaining("submodule") });
    expect(hub.requests.filter((request) => request.method === "POST")).toEqual(
      [],
    );
  });

  test("shows the policy modes: an executable bit flip, a symlink, and a file read from a big base", async () => {
    writeFileSync(join(work, "big.txt"), "b".repeat(1_300_000));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "big base");
    base = git(work, "rev-parse", "HEAD");
    hub = fakeGitHub();
    hub.seed(work, base, "refs/heads/main");
    chmodSync(join(work, "keep.txt"), 0o755);
    symlinkSync("../outside", join(work, "link"));
    writeFileSync(join(work, "big.txt"), `${"b".repeat(1_300_000)}x`);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "modes");
    git(work, "branch", "-f", "agent/modes", "HEAD");

    const seen: Record<string, unknown> = {};

    await push("agent/modes", async (pushed) => {
      for (const file of pushed.files) {
        const before = await file.before();
        const after = await file.after();

        seen[file.path] = {
          before: before && { mode: before.mode, size: before.size },
          after: after && { mode: after.mode, text: after.text?.slice(0, 20) },
        };
      }
    });

    expect(seen["keep.txt"]).toEqual({
      before: { mode: undefined, size: 5 },
      after: { mode: "100755", text: "keep\n" },
    });
    expect(seen.link).toEqual({
      before: undefined,
      after: { mode: "120000", text: "../outside" },
    });
    expect(seen["big.txt"]).toMatchObject({
      before: { mode: undefined, size: 1_300_000 },
    });
  });

  test("refuses paths git can't hold, so a policy never matches a different path than the push writes", async () => {
    const sha = "a".repeat(40);
    const blob = "b".repeat(40);
    const b64 = (text: string) => Buffer.from(text).toString("base64");

    for (const path of [
      "./.github/x.yml",
      "a/../.github/x.yml",
      ".git/config",
      "a/.GIT/hooks",
      "/etc/passwd",
      "a//b",
      "a\\b",
    ]) {
      const outcome = await pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${[
          `COMMIT ${sha} ${base}`,
          `AUTHOR ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `COMMITTER ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `MESSAGE ${b64("m")}`,
          `CHANGE A 000000 100644 ${"0".repeat(40)} ${blob} ${b64(path)}`,
          `BLOB ${blob} ${b64("x")}`,
        ].join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      });

      expect(outcome, path).toMatchObject({
        refused: expect.stringContaining("characters git_push can't check"),
      });
    }

    await expect(
      commitFiles({
        remote,
        token,
        fetch: hub.handle,
        ref: "refs/heads/x",
        message: "m",
        files: { "../x": "x" },
      }),
    ).resolves.toMatchObject({
      refused: expect.stringContaining("not a path"),
    });
  });

  test("a root commit and a signed commit are refused, a rebased branch is not a fast-forward even to another ref", async () => {
    git(work, "checkout", "--quiet", "--orphan", "agent/root");
    git(work, "rm", "-rf", "--quiet", ".");
    writeFileSync(join(work, "r.txt"), "root\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "root");

    const refusal = await pushManifest({
      remote,
      token,
      fetch: hub.handle,
      manifest: manifestOf(git(work, "rev-parse", "HEAD")),
      target: { src: "refs/heads/agent/root", dst: "refs/heads/agent/root" },
      tip: git(work, "rev-parse", "HEAD"),
      state: { base },
    });

    expect(refusal).toMatchObject({
      refused: expect.stringContaining("root commit"),
    });
    expect(
      parseManifest(manifestOf(git(work, "rev-parse", "HEAD"))).commits[0]
        ?.parents,
    ).toEqual([]);

    const sha = "a".repeat(40);
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const header = [
      `COMMIT ${sha} ${base}`,
      "UNSUPPORTED",
      `AUTHOR ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
      `COMMITTER ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
      `MESSAGE ${b64("m")}`,
    ];

    await expect(
      pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${header.join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      }),
    ).resolves.toMatchObject({ refused: expect.stringContaining("signed") });

    // A commit that doesn't sit on the base, sent to a ref the policy picked.
    await expect(
      pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${header
          .filter((line) => line !== "UNSUPPORTED")
          .join("\n")
          .replace(base, "c".repeat(40))}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
        policy: () => {
          return { ref: "refs/heads/elsewhere" };
        },
      }),
    ).resolves.toMatchObject({
      pushed: [{ status: "non-fast-forward", asked: false }],
    });
    expect(hub.refs.has("refs/heads/elsewhere")).toBe(false);
  });

  test("a branch that appears between the check and the push is not forced", async () => {
    branch("agent/appears", () => {
      writeFileSync(join(work, "p.txt"), "p\n");
    });
    hub.fail.match = /POST \/git\/refs/;
    hub.fail.status = 422;
    hub.fail.before = () => {
      hub.refs.set("refs/heads/agent/appears", base);
    };

    await expect(push("agent/appears")).resolves.toMatchObject({
      pushed: [{ status: "non-fast-forward" }],
    });
  });

  test("an empty repository ends the step instead of retrying it", async () => {
    hub.fail.match = /GET \/git\/ref\//;
    hub.fail.status = 409;

    await expect(
      remoteState({ remote, ref: "refs/heads/x", token, fetch: hub.handle }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  test("a path twice in one commit, or a file where a directory is, is refused", async () => {
    const sha = "a".repeat(40);
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const zero = "0".repeat(40);
    const run = (paths: string[]) => {
      return pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${[
          `COMMIT ${sha} ${base}`,
          `AUTHOR ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `COMMITTER ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `MESSAGE ${b64("m")}`,
          ...paths.map((path) => {
            return `CHANGE A 000000 100644 ${zero} ${"b".repeat(40)} ${b64(path)}`;
          }),
          `BLOB ${"b".repeat(40)} ${b64("x")}`,
        ].join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      });
    };

    await expect(run(["docs/ok.md", "docs/ok.md"])).resolves.toMatchObject({
      refused: expect.stringContaining("appears twice"),
    });
    await expect(run(["a", "a/b"])).resolves.toMatchObject({
      refused: expect.stringContaining("becomes a directory"),
    });
    expect(hub.requests.filter((request) => request.method === "POST")).toEqual(
      [],
    );
  });

  test("a policy that can't read a file reports it; a redirected protected ref is not 'behind'", async () => {
    branch("agent/unreadable", () => {
      writeFileSync(join(work, "keep.txt"), "changed\n");
    });
    hub.fail.match = /GET \/contents\//;
    hub.fail.status = 401;

    await expect(
      push("agent/unreadable", async (pushed) => {
        await pushed.files[0]?.before();
      }),
    ).resolves.toMatchObject({ failed: expect.stringContaining("401") });

    // The policy sends the push to a branch that exists at an ancestor of the
    // base and is protected: the answer is the rule's, not "behind".
    hub.fail.match = /PATCH \/git\/refs\//;
    hub.fail.status = 422;
    hub.refs.set("refs/heads/agent/protected", base);
    await expect(
      push("agent/unreadable", () => {
        return { ref: "refs/heads/agent/protected" };
      }),
    ).resolves.toMatchObject({ failed: expect.stringContaining("422") });
  });

  test("a server error or a rate limit is tried again, a rule's refusal is reported", async () => {
    branch("agent/retry", () => {
      writeFileSync(join(work, "t.txt"), "t\n");
    });
    hub.fail.match = /POST \/git\/trees/;
    hub.fail.status = 503;
    await expect(push("agent/retry")).rejects.toThrow(/503/);
    hub.fail.status = 403;
    hub.fail.headers = { "x-ratelimit-remaining": "0" };
    await expect(push("agent/retry")).rejects.toThrow(/403/);
    hub.fail.headers = undefined;
    await expect(push("agent/retry")).resolves.toHaveProperty("failed");

    // A protected branch answers 422 to a valid fast-forward.
    hub.fail.match = /PATCH \/git\/refs\//;
    hub.fail.status = 422;
    hub.refs.set("refs/heads/agent/retry", base);
    await expect(push("agent/retry")).resolves.toMatchObject({
      failed: expect.stringContaining("422"),
    });
    expect(hub.refs.get("refs/heads/agent/retry")).toBe(base);
  });

  test("refuses text that isn't UTF-8 in a path, and the NTFS and HFS names of .git", async () => {
    const sha = "a".repeat(40);
    const b64 = (bytes: Buffer) => bytes.toString("base64");
    const run = (path: Buffer) => {
      return pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${[
          `COMMIT ${sha} ${base}`,
          `AUTHOR ${b64(Buffer.from("A"))} ${b64(Buffer.from("a@x"))} 2026-10-28T00:00:00Z`,
          `COMMITTER ${b64(Buffer.from("A"))} ${b64(Buffer.from("a@x"))} 2026-10-28T00:00:00Z`,
          `MESSAGE ${b64(Buffer.from("m"))}`,
          `CHANGE A 000000 100644 ${"0".repeat(40)} ${"b".repeat(40)} ${b64(path)}`,
          `BLOB ${"b".repeat(40)} ${b64(Buffer.from("x"))}`,
        ].join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      });
    };

    await expect(
      run(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
    ).resolves.toMatchObject({
      refused: expect.stringContaining("without git"),
    });
    await expect(run(Buffer.from(".git./config"))).resolves.toMatchObject({
      refused: expect.stringContaining("can't check"),
    });
    expect(isPlainPath("GIT~1/x")).toBe(false);
    expect(isPlainPath(".git /x")).toBe(false);
    expect(isPlainPath(".gitignore")).toBe(true);
    expect(isPlainPath("a.git/x")).toBe(true);
  });

  test("a new branch may be cut from an older commit of the default branch", async () => {
    // main moved on; the branch was cut before that.
    writeFileSync(join(work, "later.txt"), "later\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "main moves");

    const newMain = git(work, "rev-parse", "HEAD");

    hub.seed(work, newMain, "refs/heads/main");
    branch("agent/old-base", () => {
      writeFileSync(join(work, "mine.txt"), "mine\n");
    });

    const seen: Record<string, unknown> = {};
    const outcome = await push("agent/old-base", async (pushed) => {
      const later = pushed.files.find((file) => file.path === "later.txt");

      seen.paths = pushed.paths;
      seen.laterBefore = (await later?.before())?.text;
      seen.laterAfter = (await later?.after())?.text;
      seen.patch = await pushed.patch();
    });

    expect(outcome).toMatchObject({
      pushed: [{ status: "pushed", ref: "refs/heads/agent/old-base" }],
    });
    // The branch lacks what main gained since, so the policy sees it as part
    // of the push: the default tip's file there, and nothing after.
    expect(seen.paths).toEqual(["later.txt", "mine.txt"]);
    expect(seen.laterBefore).toBe("later\n");
    expect(seen.laterAfter).toBeUndefined();
    expect(seen.patch).toContain("the default branch's tip");
    expect(seen.patch).toContain("-later");

    const pushedSha = hub.refs.get("refs/heads/agent/old-base") ?? "";

    expect(pushedSha).toBe(git(work, "rev-parse", "refs/heads/agent/old-base"));
    expect(hub.commits.get(pushedSha)?.parents).toEqual([base]);
  });

  test("a new branch can't be cut from a commit the default branch doesn't contain", async () => {
    // An unreviewed commit that exists in the repository (a fork's, a deleted
    // branch's) but is not in main.
    git(work, "checkout", "--quiet", "-B", "side", base);
    mkdirSync(join(work, ".github"), { recursive: true });
    writeFileSync(join(work, ".github/ci.yml"), "evil\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "unreviewed");

    const side = git(work, "rev-parse", "HEAD");

    hub.seed(work, side, "refs/pull/1/head");
    git(work, "checkout", "--quiet", "-B", "agent/forged", side);
    writeFileSync(join(work, "docs.md"), "docs\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "docs only");

    const tip = git(work, "rev-parse", "HEAD");
    const ref = "refs/heads/agent/forged";
    const state = await remoteState({ remote, ref, token, fetch: hub.handle });

    hub.requests.length = 0;

    // The sandbox leaves out the unreviewed commit and claims it as the base.
    const outcome = await pushManifest({
      remote,
      token,
      fetch: hub.handle,
      manifest: manifestOf(tip, side),
      target: { src: ref, dst: ref },
      tip,
      state,
      policy: (push) => {
        return push.paths.every((path) => {
          return path.startsWith("docs");
        })
          ? undefined
          : { refuse: "docs only" };
      },
    });

    expect(outcome).toMatchObject({ pushed: [{ status: "non-fast-forward" }] });
    expect(hub.refs.has(ref)).toBe(false);
    expect(hub.requests.filter((request) => request.method === "POST")).toEqual(
      [],
    );
  });

  test("an unknown or unreadable base ends cleanly, and a rights error is not 'behind'", async () => {
    const sha = "a".repeat(40);
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const run = (parent: string) => {
      return pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: `${[
          `COMMIT ${sha} ${parent}`,
          `AUTHOR ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `COMMITTER ${b64("A")} ${b64("a@x")} 2026-10-28T00:00:00Z`,
          `MESSAGE ${b64("m")}`,
        ].join("\n")}\n`,
        target: { src: "refs/heads/x", dst: "refs/heads/x" },
        tip: sha,
        state: { base },
      });
    };

    await expect(run("c".repeat(40))).resolves.toMatchObject({
      pushed: [{ status: "non-fast-forward" }],
    });

    hub.fail.match = /GET \/compare\//;
    hub.fail.status = 401;
    await expect(run("c".repeat(40))).rejects.toBeInstanceOf(NonRetriableError);
  });

  test("says when the remote's hashes differ from the sandbox's", async () => {
    branch("agent/hash", () => {
      writeFileSync(join(work, "h.txt"), "h\n");
    });

    const ref = "refs/heads/agent/hash";
    const real = git(work, "rev-parse", ref);
    const state = await remoteState({ remote, ref, token, fetch: hub.handle });
    const run = (tip: string) => {
      return pushManifest({
        remote,
        token,
        fetch: hub.handle,
        manifest: manifestOf(real, state.base),
        target: { src: ref, dst: ref },
        tip,
        state,
      });
    };
    const same = (await run(real)) as { pushed: { sandboxSha?: string }[] };

    expect(same.pushed[0]?.sandboxSha).toBeUndefined();

    hub.refs.delete(ref);

    const other = (await run("e".repeat(40))) as {
      pushed: { sandboxSha?: string }[];
    };

    expect(other.pushed[0]?.sandboxSha).toBe("e".repeat(40));
  });

  test("a retry after the ref was written but the answer was lost pushes the same commit", async () => {
    branch("agent/lost", () => {
      writeFileSync(join(work, "l.txt"), "l\n");
    });

    const ref = "refs/heads/agent/lost";
    const tip = git(work, "rev-parse", ref);
    const state = await remoteState({ remote, ref, token, fetch: hub.handle });
    const manifest = manifestOf(tip, state.base);
    let lost = true;
    const flaky: typeof fetch = async (input, init) => {
      const response = await hub.handle(input, init);

      if (
        lost &&
        init?.method === "POST" &&
        String(input).endsWith("/git/refs")
      ) {
        lost = false;

        throw new TypeError("network lost after the ref was made");
      }

      return response;
    };
    const attempt = () => {
      return pushManifest({
        remote,
        token,
        fetch: flaky,
        manifest,
        target: { src: ref, dst: ref },
        tip,
        state,
      });
    };

    await expect(attempt()).rejects.toThrow("network lost");
    expect(hub.refs.get(ref)).toBe(tip);
    await expect(attempt()).resolves.toMatchObject({
      pushed: [{ status: "pushed", sha: tip }],
    });
    expect(hub.refs.get(ref)).toBe(tip);

    // An existing branch: the PATCH is made, the answer is lost.
    writeFileSync(join(work, "l2.txt"), "l2\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "more");

    const next = git(work, "rev-parse", ref);
    const state2 = await remoteState({ remote, ref, token, fetch: hub.handle });
    const manifest2 = manifestOf(next, state2.base);
    let lost2 = true;
    const flaky2: typeof fetch = async (input, init) => {
      const response = await hub.handle(input, init);

      if (lost2 && init?.method === "PATCH") {
        lost2 = false;

        throw new TypeError("network lost after the update");
      }

      return response;
    };
    const attempt2 = () => {
      return pushManifest({
        remote,
        token,
        fetch: flaky2,
        manifest: manifest2,
        target: { src: ref, dst: ref },
        tip: next,
        state: state2,
      });
    };

    await expect(attempt2()).rejects.toThrow("network lost");
    await expect(attempt2()).resolves.toMatchObject({
      pushed: [{ status: "pushed", sha: next }],
    });
  });

  test("a file the policy can't read because it is too big ends the step with a clear error", async () => {
    branch("agent/toobig", () => {
      writeFileSync(join(work, "keep.txt"), "edited\n");
    });
    hub.reported.set("keep.txt", 9_000_000);

    const failure = await push("agent/toobig", async (pushed) => {
      await pushed.files[0]?.before();
    }).catch((error: unknown) => {
      return error;
    });

    expect(failure).toBeInstanceOf(NonRetriableError);
    expect((failure as Error).message).toContain("keep.txt is 9000000 bytes");
  });

  test("a file that becomes a directory in one commit is refused with what to do", async () => {
    branch("agent/dir", () => {
      git(work, "rm", "--quiet", "keep.txt");
      mkdirSync(join(work, "keep.txt"));
      writeFileSync(join(work, "keep.txt/inner.txt"), "inner\n");
    });

    await expect(push("agent/dir")).resolves.toMatchObject({
      refused: expect.stringContaining("in two commits"),
    });
  });

  test("the sandbox that lacks the remote's commit makes the script exit 4", () => {
    const ran = spawnSync(
      "sh",
      ["-c", manifestScript, "sh", "d".repeat(40), "HEAD", join(work, ".m")],
      { cwd: work, env, encoding: "utf8" },
    );

    expect(ran.status).toBe(4);
  });

  test("a binary or unreadable file is a binary blob for the policy", async () => {
    branch("agent/bin", () => {
      writeFileSync(join(work, "pic.png"), Buffer.from([0x89, 0, 1, 2]));
    });

    const kinds: boolean[] = [];

    await push("agent/bin", async (pushed) => {
      for (const file of pushed.files) {
        kinds.push((await file.after())?.binary ?? false);
      }
    });

    expect(kinds).toEqual([true]);
  });
});

describe("notes and committing files", { timeout: 60_000 }, () => {
  let work: string;
  let base: string;
  let hub: ReturnType<typeof fakeGitHub>;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "git-api-files-"));
    git(work, "init", "--quiet", "-b", "main");
    writeFileSync(join(work, "keep.txt"), "keep\n");
    writeFileSync(join(work, "drop.txt"), "drop\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "base");
    base = git(work, "rev-parse", "HEAD");
    hub = fakeGitHub();
    hub.seed(work, base, "refs/heads/main");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const files = (commit: string) => {
    const tree = hub.trees.get(hub.commits.get(commit)?.tree ?? "");

    return Object.fromEntries(
      [...(tree ?? [])].map(([path, entry]) => {
        return [path, Buffer.from(hub.blobs.get(entry.sha) as Uint8Array)];
      }),
    );
  };

  const skillRef = "refs/heads/skills/triage";
  const options = () => {
    return {
      remote,
      token,
      fetch: hub.handle,
      ref: skillRef,
      message: "Add the triage skill",
    };
  };

  test("commits a file set to a new branch off the default branch: text, bytes and a delete", async () => {
    const outcome = await commitFiles({
      ...options(),
      files: {
        "triage/SKILL.md": "# triage\n",
        "bin.dat": new Uint8Array([0, 1, 2, 255]),
        "drop.txt": null,
      },
      date: "2026-10-28T12:00:00Z",
    });

    expect(outcome).toMatchObject({
      pushed: [
        { ref: "refs/heads/skills/triage", status: "pushed", asked: true },
      ],
    });

    const sha = hub.refs.get("refs/heads/skills/triage") ?? "";
    const made = hub.commits.get(sha);

    expect(made?.parents).toEqual([base]);
    expect(made?.message).toBe("Add the triage skill");
    expect(made?.author).toMatchObject({
      name: "inngest-agent",
      date: "2026-10-28T12:00:00Z",
    });

    const tree = files(sha);

    expect(Object.keys(tree).sort()).toEqual([
      "bin.dat",
      "keep.txt",
      "triage/SKILL.md",
    ]);
    expect(tree["triage/SKILL.md"]?.toString()).toBe("# triage\n");
    expect([...(tree["bin.dat"] ?? [])]).toEqual([0, 1, 2, 255]);
    expect(
      hub.requests.every((request) => {
        return request.authorization === `Bearer ${token}`;
      }),
    ).toBe(true);
  });

  test("adds a commit to a branch that exists, and a second call builds on the first", async () => {
    await commitFiles({ ...options(), files: { "one.md": "1\n" } });

    const first = hub.refs.get(skillRef);
    const outcome = await commitFiles({
      ...options(),
      message: "second",
      files: { "two.md": "2\n" },
    });

    expect(outcome).toMatchObject({
      pushed: [{ status: "pushed", oldSha: first }],
    });
    expect(Object.keys(files(hub.refs.get(skillRef) ?? "")).sort()).toEqual([
      "drop.txt",
      "keep.txt",
      "one.md",
      "two.md",
    ]);
  });

  test("a commit that changes nothing is refused", async () => {
    await expect(
      commitFiles({ ...options(), files: { "keep.txt": "keep\n" } }),
    ).resolves.toEqual({ refused: "the commit would change nothing" });
    expect(hub.refs.has(skillRef)).toBe(false);
  });

  test("keeps the executable bit when asked", async () => {
    await commitFiles({
      ...options(),
      files: { "run.sh": { content: "#!/bin/sh\n", executable: true } },
    });

    const tree = hub.trees.get(
      hub.commits.get(hub.refs.get(skillRef) ?? "")?.tree ?? "",
    );

    expect(tree?.get("run.sh")?.mode).toBe("100755");
  });

  test("the policy sees the paths, the files before and after, and an empty sha", async () => {
    const seen: unknown[] = [];

    await commitFiles({
      ...options(),
      files: {
        "keep.txt": "kept, edited\n",
        "new.md": "new\n",
        "drop.txt": null,
      },
      policy: async (push) => {
        seen.push({
          sha: push.sha,
          branch: push.branch,
          paths: push.paths,
          commits: push.commits.map((commit) => {
            return commit.subject;
          }),
        });
        seen.push(
          Object.fromEntries(
            await Promise.all(
              push.files.map(async (file) => {
                return [
                  file.path,
                  [(await file.before())?.text, (await file.after())?.text],
                ] as const;
              }),
            ),
          ),
        );
        seen.push(await push.patch());

        return undefined;
      },
    });

    expect(seen[0]).toEqual({
      sha: "",
      branch: "skills/triage",
      paths: ["drop.txt", "keep.txt", "new.md"],
      commits: ["Add the triage skill"],
    });
    expect(seen[1]).toEqual({
      "drop.txt": ["drop\n", undefined],
      "keep.txt": ["keep\n", "kept, edited\n"],
      "new.md": [undefined, "new\n"],
    });
    expect(seen[2]).toContain("+kept, edited");
    expect(seen[2]).toContain("-drop");
  });

  test("a policy refusal commits nothing, and an empty file set is refused", async () => {
    hub.requests.length = 0;

    await expect(
      commitFiles({
        ...options(),
        files: { ".github/ci.yml": "x\n" },
        policy: () => {
          return { refuse: "no workflows" };
        },
      }),
    ).resolves.toEqual({ refused: "no workflows" });
    await expect(commitFiles({ ...options(), files: {} })).resolves.toEqual({
      refused: "there are no files to commit",
    });
    expect(hub.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
    expect(hub.refs.has(skillRef)).toBe(false);
  });

  test("the policy's notes come back in the result, from either way of pushing", async () => {
    const outcome = await commitFiles({
      ...options(),
      files: { "a.md": "a\n" },
      policy: (push) => {
        return { notes: [`allowed ${push.paths.join(",")}`, "audited"] };
      },
    });

    expect(outcome).toMatchObject({
      pushed: [{ notes: ["allowed a.md", "audited"] }],
    });

    const moved = await commitFiles({
      ...options(),
      ref: "refs/heads/skills/other",
      files: { "b.md": "b\n" },
      policy: () => {
        return { ref: "refs/heads/skills/safe", notes: ["moved"] };
      },
    });

    expect(moved).toMatchObject({
      pushed: [
        { ref: "refs/heads/skills/safe", asked: false, notes: ["moved"] },
      ],
    });
  });

  test("malformed notes fail the push before anything is created", async () => {
    hub.requests.length = 0;

    await expect(
      commitFiles({
        ...options(),
        files: { "a.md": "a\n" },
        policy: () => {
          return { notes: ["x".repeat(501)] };
        },
      }),
    ).rejects.toThrow(/notes must be at most/);
    expect(hub.requests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
  });
});

describe("remotes", () => {
  test.each([
    ["src/a.ts", true],
    ["a b/c d.txt", true],
    ["日本/x", true],
    ["", false],
    ["/x", false],
    ["a//b", false],
    ["./a", false],
    ["a/..", false],
    [".git/config", false],
    ["a/.Git/x", false],
    ["a\\b", false],
    ["a\nb", false],
  ])("isPlainPath(%j)", (path, expected) => {
    expect(isPlainPath(path)).toBe(expected);
  });

  test("isApiRemote takes any https host/owner/repo", () => {
    expect(isApiRemote("https://ghe.example.com/acme/app")).toBe(true);
    expect(isApiRemote("https://example.com/one")).toBe(false);
  });

  test.each([
    ["https://github.com/acme/app", true],
    ["https://github.com/acme/app.git", true],
    ["https://ghe.example.com/acme/app", false],
    ["https://example.com/just-one", false],
    ["not a url", false],
  ])("%s", (url, expected) => {
    expect(isGitHubRemote(url)).toBe(expected);
  });

  test("parses a manifest and rejects a line it doesn't know", () => {
    expect(() => parseManifest("NOPE x\n")).toThrow(/starts with NOPE/);
    expect(() =>
      parseManifest(`COMMIT ${"a".repeat(40)} ${"b".repeat(40)}\nWHAT x\n`),
    ).toThrow(/unknown line/);
    expect(parseManifest("").commits).toEqual([]);
  });
});
