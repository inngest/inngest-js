/**
 * @module
 * Tests for `tool.shim.git()`: the handler runs against a sandbox on this
 * machine and a git remote that serves only a token.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  backendPath,
  type GitRemote,
  git,
  localSandbox,
  startGitRemote,
} from "./git-fixtures/test-helpers.ts";
import type { GitPush, GitShimOptions } from "./gitShim.ts";
import { withShims } from "./shims.ts";
import type { ToolBinary } from "./toolBinary.ts";
import { resolveToolCall, tool } from "./tools.ts";

const token = "ghs_secret_token_value";
const binary: ToolBinary = {
  path: "/unused",
  sha256: "",
  load: async () => {
    return new Uint8Array();
  },
};

interface Wire {
  exit?: number;
  stdout?: string;
  stderr?: string;
  exec?: unknown;
}

describe.skipIf(!backendPath)("tool.shim.git", { timeout: 60_000 }, () => {
  let remote: GitRemote;
  let root: string;
  const sandbox = localSandbox();

  beforeEach(async () => {
    remote = await startGitRemote(token);
    root = mkdtempSync(join(tmpdir(), "git-shim-"));
  });

  afterEach(async () => {
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(join(tmpdir(), "git-remote-"), { force: true });
  });

  const shimFor = (options: Partial<GitShimOptions> = {}) => {
    return tool.shim.git({
      remote: remote.url,
      token: () => {
        return token;
      },
      ...options,
    });
  };

  const call = async (
    options: Partial<GitShimOptions>,
    argv: string[],
    cwd = root,
  ): Promise<Wire> => {
    const built = withShims("true", [shimFor(options)], { binary });
    const resolved = await resolveToolCall(
      built.tools,
      {
        op: "call",
        id: 1,
        tool: "inngestShim",
        args: [{ name: "git", argv, cwd, stdin: "" }],
      },
      "{}",
    );
    if (!("invoke" in resolved) || !resolved.invoke) {
      throw new Error("expected a call to run");
    }

    return (await resolved.invoke({
      signal: new AbortController().signal,
      idempotencyKey: `k-${Math.random()}`,
      sandbox,
    })) as Wire;
  };

  const clone = async (options: Partial<GitShimOptions> = {}) => {
    const out = await call(options, ["clone", remote.url, "work"]);
    expect(out.exit).toBe(0);

    return join(root, "work");
  };

  const commit = (
    work: string,
    file: string,
    text: string,
    branch?: string,
  ) => {
    if (branch) {
      git(work, "checkout", "--quiet", "-B", branch);
    }

    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), text);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", `change ${file}`);
  };

  const remoteHas = (ref: string): string | undefined => {
    try {
      return git(remote.dir, "rev-parse", "--verify", ref);
    } catch {
      return undefined;
    }
  };

  test("clone unpacks the repository into the sandbox with the host's token", async () => {
    const work = await clone();

    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("hello\n");
    expect(git(work, "remote", "get-url", "origin")).toBe(remote.url);
    expect(git(work, "rev-parse", "HEAD")).toBe(remoteHas("main"));
    expect(remote.seen.length).toBeGreaterThan(0);
  });

  test("the token is nowhere in the sandbox", async () => {
    const work = await clone();
    commit(work, "src/b.ts", "export const b = 2;\n", "agent/b");
    await call({}, ["push", "origin", "agent/b"], work);

    const found = (
      await sandbox.commands.run([
        "grep",
        "-rlE",
        `${token}|${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        root,
      ])
    ).stdout.trim();

    expect(found).toBe("");
  });

  test("clone supports --depth and a branch", async () => {
    const out = await call({}, [
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      remote.url,
      "shallow",
    ]);

    expect(out.exit).toBe(0);
    expect(git(join(root, "shallow"), "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("clone refuses another repository and unknown options", async () => {
    const other = await call({}, ["clone", "https://example.com/x/y.git"]);
    const flag = await call({}, ["clone", "--mirror", remote.url]);

    expect(other.exit).toBe(126);
    expect(other.stderr).toContain("can only clone");
    expect(flag.exit).toBe(126);
    expect(flag.stderr).toContain("--mirror isn't supported");
  });

  test("push sends new commits to the remote from the host", async () => {
    const work = await clone();
    commit(work, "src/b.ts", "export const b = 2;\n", "agent/b");

    const out = await call({}, ["push", "-u", "origin", "agent/b"], work);

    expect(out.exit).toBe(0);
    expect(out.stderr).toContain("[new branch]");
    expect(remoteHas("refs/heads/agent/b")).toBe(
      git(work, "rev-parse", "HEAD"),
    );
    expect(git(work, "rev-parse", "refs/remotes/origin/agent/b")).toBe(
      git(work, "rev-parse", "HEAD"),
    );
  });

  test("push with no arguments pushes the current branch", async () => {
    const work = await clone();
    commit(work, "src/c.ts", "export const c = 3;\n", "agent/c");

    const out = await call({}, ["push"], work);

    expect(out.exit).toBe(0);
    expect(remoteHas("refs/heads/agent/c")).toBeDefined();
  });

  test("a policy sees the branch, commits, paths and patch, computed on the host", async () => {
    const work = await clone();
    commit(work, "src/d.ts", "export const d = 4;\n", "agent/d");
    let seen: GitPush | undefined;
    let patch = "";

    const out = await call(
      {
        policy: async (push) => {
          seen = push;
          patch = await push.patch();
        },
      },
      ["push", "origin", "agent/d"],
      work,
    );

    expect(out.exit).toBe(0);
    expect(seen).toMatchObject({
      remote: remote.url,
      ref: "refs/heads/agent/d",
      branch: "agent/d",
      sha: git(work, "rev-parse", "HEAD"),
      fastForward: true,
      paths: ["src/d.ts"],
      commits: [{ subject: "change src/d.ts" }],
    });
    expect(seen?.oldSha).toBeUndefined();
    expect(patch).toContain("export const d = 4;");
  });

  test("a policy can refuse by branch, by path and by content", async () => {
    const work = await clone();
    commit(work, "README.md", "changed\n", "main");

    const branch = await call(
      {
        policy: (push) => {
          if (!push.branch?.startsWith("agent/")) {
            return { refuse: "agents push to agent/* branches" };
          }

          return undefined;
        },
      },
      ["push", "origin", "main"],
      work,
    );
    expect(branch.exit).toBe(126);
    expect(branch.stderr).toContain("agents push to agent/* branches");
    expect(remoteHas("main")).not.toBe(git(work, "rev-parse", "HEAD"));

    const paths = await call(
      {
        policy: (push) => {
          const outside = push.paths.filter((path) => {
            return !path.startsWith("src/");
          });
          if (outside.length > 0) {
            return { refuse: `outside src/: ${outside.join(", ")}` };
          }

          return undefined;
        },
      },
      ["push", "origin", "main:agent/readme"],
      work,
    );
    expect(paths.stderr).toContain("outside src/: README.md");
    expect(remoteHas("refs/heads/agent/readme")).toBeUndefined();

    commit(work, "src/key.ts", 'export const k = "AKIAABCDEFGHIJKLMNOP";\n');
    const secret = await call(
      {
        policy: async (push) => {
          if (/AKIA[0-9A-Z]{16}/.test(await push.patch())) {
            return { refuse: "looks like an AWS key" };
          }

          return undefined;
        },
      },
      ["push", "origin", "main:agent/key"],
      work,
    );
    expect(secret.stderr).toContain("looks like an AWS key");
    expect(remoteHas("refs/heads/agent/key")).toBeUndefined();
  });

  test("a policy can send the push to another ref", async () => {
    const work = await clone();
    commit(work, "src/e.ts", "export const e = 5;\n", "main");

    const out = await call(
      {
        policy: (push) => {
          if (push.branch === "main") {
            return { ref: "refs/heads/agent/e" };
          }

          return undefined;
        },
      },
      ["push", "origin", "main"],
      work,
    );

    expect(out.exit).toBe(0);
    expect(remoteHas("refs/heads/agent/e")).toBe(
      git(work, "rev-parse", "HEAD"),
    );
    expect(remoteHas("main")).not.toBe(git(work, "rev-parse", "HEAD"));
  });

  test("a push that is not a fast-forward is rejected, and the policy is told", async () => {
    const work = await clone();
    commit(work, "src/f.ts", "export const f = 6;\n", "main");
    const other = join(root, "other");
    git(root, "clone", "--quiet", remote.dir, other);
    commit(other, "src/g.ts", "export const g = 7;\n", "main");
    git(other, "push", "--quiet", "origin", "main");
    let fastForward: boolean | undefined;

    const out = await call(
      {
        policy: (push) => {
          fastForward = push.fastForward;
        },
      },
      ["push", "origin", "main"],
      work,
    );

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain("non-fast-forward");
    expect(fastForward).toBe(false);
  });

  test("force pushes, deletes and other remotes are refused", async () => {
    const work = await clone();

    for (const argv of [
      ["push", "--force"],
      ["push", "origin", "+main"],
      ["push", "origin", ":main"],
      ["push", "--delete", "origin", "main"],
      ["push", "elsewhere", "main"],
    ]) {
      const out = await call({}, argv, work);

      expect(out.exit, argv.join(" ")).toBe(126);
    }

    expect(remoteHas("main")).toBe(git(work, "rev-parse", "HEAD"));
  });

  test("fetch brings the remote's new commits into the sandbox", async () => {
    const work = await clone();
    const other = join(root, "other");
    git(root, "clone", "--quiet", remote.dir, other);
    commit(other, "src/h.ts", "export const h = 8;\n", "main");
    git(other, "push", "--quiet", "origin", "main");

    const out = await call({}, ["fetch"], work);

    expect(out.exit).toBe(0);
    expect(git(work, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(other, "rev-parse", "HEAD"),
    );
  });

  test("-C names the repository, and other git commands run the real git", async () => {
    const work = await clone();
    commit(work, "src/i.ts", "export const i = 9;\n", "agent/i");

    const out = await call({}, ["-C", "work", "push", "origin", "agent/i"]);
    const status = await call({}, ["status"], work);
    const pull = await call({}, ["pull"], work);

    expect(out.exit).toBe(0);
    expect(status).toEqual({ exec: {} });
    expect(pull.exit).toBe(126);
    expect(pull.stderr).toContain("git fetch and git merge");
  });

  test("a push over maxBytes is refused", async () => {
    const work = await clone();
    commit(work, "src/big.bin", "x".repeat(10_000), "agent/big");

    const out = await call(
      { maxBytes: 100 },
      ["push", "origin", "agent/big"],
      work,
    );

    expect(out.exit).toBe(126);
    expect(out.stderr).toContain("more than the 100");
    expect(existsSync(join(root, "nothing"))).toBe(false);
  });

  test("a wrong token fails without printing it", async () => {
    const work = await clone();
    commit(work, "src/j.ts", "export const j = 10;\n", "agent/j");

    await expect(
      call(
        { token: () => "ghs_wrong_token" },
        ["push", "origin", "agent/j"],
        work,
      ),
    ).rejects.toThrow(/listing the remote failed/);
  });

  test("a push of more than 500 commits is refused before the policy runs", async () => {
    const work = await clone();
    git(work, "checkout", "--quiet", "-B", "agent/many");
    for (let at = 0; at < 501; at++) {
      git(work, "commit", "--quiet", "--allow-empty", "-m", `c${at}`);
    }

    let asked = false;
    const out = await call(
      {
        policy: () => {
          asked = true;

          return undefined;
        },
      },
      ["push", "origin", "agent/many"],
      work,
    );

    expect(out.exit).toBe(126);
    expect(out.stderr).toContain("at most 500");
    expect(asked).toBe(false);
    expect(remoteHas("refs/heads/agent/many")).toBeUndefined();
  });

  test("a path git would quote is refused, and a rename shows both paths", async () => {
    const work = await clone();
    commit(work, 'src/we"ird.txt', "x\n", "agent/q");
    const quoted = await call({}, ["push", "origin", "agent/q"], work);

    expect(quoted.exit).toBe(126);
    expect(quoted.stderr).toContain("can't check");

    git(work, "checkout", "--quiet", "-B", "agent/r", "main");
    git(work, "mv", "README.md", "src/readme.md");
    git(work, "commit", "--quiet", "-m", "move");
    let paths: string[] = [];
    await call(
      {
        policy: (push) => {
          paths = push.paths;

          return undefined;
        },
      },
      ["push", "origin", "agent/r"],
      work,
    );

    expect(paths).toEqual(["README.md", "src/readme.md"]);
  });

  test("more than one ref at a time is refused", async () => {
    const work = await clone();
    commit(work, "src/m.ts", "export const m = 1;\n", "agent/m");

    const out = await call({}, ["push", "origin", "agent/m", "main"], work);

    expect(out.exit).toBe(126);
    expect(remoteHas("refs/heads/agent/m")).toBeUndefined();
  });

  test("-u sets the upstream", async () => {
    const work = await clone();
    commit(work, "src/u.ts", "export const u = 1;\n", "agent/u");

    await call({}, ["push", "-u", "origin", "agent/u"], work);

    expect(git(work, "config", "branch.agent/u.remote")).toBe("origin");
  });

  test("options are validated", () => {
    expect(() => {
      return tool.shim.git({ remote: "", token: () => "t" });
    }).toThrow("remote URL");
    expect(() => {
      return tool.shim.git({
        remote: "https://user:secret@x.com/y.git",
        token: () => "t",
      });
    }).toThrow("without a user name or password");
    expect(() => {
      return tool.shim.git({ remote: "file:///tmp/y.git", token: () => "t" });
    }).toThrow("http(s)");
    expect(() => {
      return tool.shim.git({ remote: "https://x.com/y.git" } as never);
    }).toThrow("token function");
    expect(() => {
      return tool.shim.git({
        remote: "https://x/y.git",
        token: () => "t",
        maxBytes: 0,
      });
    }).toThrow("maxBytes");
  });
});
