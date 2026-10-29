/**
 * @module
 * The testing entry: the scripted model plays its script, the fakes server
 * keeps every call it is sent, the fake sandbox answers from memory and
 * cleans up after itself, a command nobody described fails, and the git
 * remote asks for its token and leaves nothing behind.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as entry from "../../../experimental/agents/testing.ts";
import {
  fakeGitDataApi,
  fakeSandbox,
  script,
  startFakes,
  startGitRemote,
  withKeys,
} from "../../../experimental/agents/testing.ts";
import { backendPath } from "./gitRemote.ts";

// A sandbox that runs commands for real on this machine, for the tests of
// that. Its commands are scripted by the test itself.
const localSandbox = (options: Parameters<typeof fakeSandbox>[0] = {}) => {
  return fakeSandbox({ execute: "local", ...options });
};

const request = (turn: number, last = "hello") => {
  return {
    messages: [{ role: "user" as const, content: last }],
    turn,
    maxTurns: 10,
    tools: [],
  };
};

const post = (
  sandbox: ReturnType<typeof fakeSandbox>,
  path: string,
  body: unknown,
) => {
  return sandbox.fetch(`http://sandboxes.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

const create = async (sandbox: ReturnType<typeof fakeSandbox>) => {
  const created = await post(sandbox, "/v2/sandboxes", {});

  return ((await created.json()) as { data: { id: string } }).data.id;
};

const exec = async (
  sandbox: ReturnType<typeof fakeSandbox>,
  id: string,
  command: string[],
) => {
  const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, {
    command,
  });
  const { data } = (await response.json()) as {
    data: { stdout: string; stderr: string; exitCode: number };
  };

  return {
    stdout: Buffer.from(data.stdout, "base64").toString(),
    stderr: Buffer.from(data.stderr, "base64").toString(),
    exitCode: data.exitCode,
  };
};

describe("the entry", () => {
  test("exports exactly the documented names", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "fakeGitDataApi",
      "fakeSandbox",
      "script",
      "startFakes",
      "startGitRemote",
      "testReporter",
      "withKeys",
    ]);
  });

  test("importing it does not look for git", async () => {
    const execFileSync = vi.fn();

    vi.resetModules();
    vi.doMock("node:child_process", async (original) => {
      return {
        ...(await original<typeof import("node:child_process")>()),
        execFileSync,
      };
    });

    try {
      await import("../../../experimental/agents/testing.ts");

      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("script", () => {
  test("answers by turn, then echoes the last user message", async () => {
    const model = script([
      { call: { name: "run", input: { n: 1 } } },
      { say: "done: {{last}}" },
    ]);

    const first = await model(request(1));
    const second = await model(request(2, "ship it"));
    const after = await model(request(3, "again"));

    expect(first.toolCalls).toMatchObject([{ name: "run", input: { n: 1 } }]);
    expect(second.text).toBe("done: ship it");
    expect(after.text).toBe("echo: again");
  });

  test("a step with when answers the first request it matches", async () => {
    const model = script([
      {
        say: "matched",
        when: (r) => {
          return r.turn === 2;
        },
      },
      { say: "plain" },
    ]);

    expect((await model(request(1))).text).toBe("plain");
    expect((await model(request(2))).text).toBe("matched");
  });
});

describe("startFakes", () => {
  test("keeps the calls it is sent and filters them", async () => {
    await using fakes = await startFakes();

    await fetch(`${fakes.url}/slack/api/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "C1", text: "hi", thread_ts: "1.0" }),
    });
    await fetch(`${fakes.url}/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "sandbox.destroy" }),
    });

    expect(fakes.posts({ channel: "slack" })).toMatchObject([
      { method: "chat.postMessage", thread: "1.0", body: { text: "hi" } },
    ]);
    expect(fakes.posts({ method: "sandbox.destroy" })).toHaveLength(1);
    expect(fakes.calls).toHaveLength(2);
  });

  test("is closed by await using", async () => {
    let url = "";

    {
      await using fakes = await startFakes();

      url = fakes.url;
    }

    await expect(fetch(`${url}/record`, { method: "POST" })).rejects.toThrow();
  });
});

describe("fakeSandbox", () => {
  test("records every operation in this process before it answers", async () => {
    await using fakes = await startFakes();
    await using sandbox = fakeSandbox({ fakes, commands: { hello: {} } });

    const id = await create(sandbox);

    // No waiting: the call is there the moment the sandbox has answered.
    expect(sandbox.posts({ method: "sandbox.create" })).toHaveLength(1);
    expect(fakes.posts({ method: "sandbox.create" })).toHaveLength(1);

    await exec(sandbox, id, ["echo", "hello"]);

    expect(fakes.posts({ method: "sandbox.exec" })).toMatchObject([
      { body: { id, command: ["echo", "hello"] } },
    ]);
  });

  test("a sandbox can be paused and resumed; a paused one runs nothing and a destroyed one is gone", async () => {
    await using sandbox = fakeSandbox({ commands: { "": {} } });

    const id = await create(sandbox);
    const status = async () => {
      const found = await sandbox.fetch(
        `http://fake.invalid/v2/sandboxes/${id}`,
      );

      return found.status === 200
        ? ((await found.json()) as { data: { status: string } }).data.status
        : found.status;
    };

    expect(await status()).toBe("RUNNING");

    await post(sandbox, `/v2/sandboxes/${id}/pause`, {});
    expect(await status()).toBe("PAUSED");
    expect(
      (await post(sandbox, `/v2/sandboxes/${id}/exec`, { command: ["true"] }))
        .status,
    ).toBe(409);

    await post(sandbox, `/v2/sandboxes/${id}/resume`, {});
    expect(await status()).toBe("RUNNING");
    expect((await exec(sandbox, id, ["true"])).exitCode).toBe(0);
    expect(sandbox.posts({ method: "sandbox.pause" })).toHaveLength(1);
    expect(sandbox.posts({ method: "sandbox.resume" })).toHaveLength(1);

    await sandbox.fetch(`http://fake.invalid/v2/sandboxes/${id}`, {
      method: "DELETE",
    });
    expect(await status()).toBe(404);
  });

  test("posts to a fakes server in another process and waits for it", async () => {
    await using fakes = await startFakes();
    await using sandbox = fakeSandbox({ recordUrl: fakes.url });

    await create(sandbox);

    expect(
      fakes.posts({ channel: "sandbox", method: "sandbox.create" }),
    ).toHaveLength(1);
  });

  test("a command no entry describes fails loudly, and the key '' matches the rest", async () => {
    await using strict = fakeSandbox({
      commands: { hello: { stdout: "world\n" } },
    });
    await using lenient = fakeSandbox({
      commands: { hello: { stdout: "world\n" }, "": {} },
    });

    const strictId = await create(strict);
    const lenientId = await create(lenient);

    expect(await exec(strict, strictId, ["echo", "hello"])).toMatchObject({
      stdout: "world\n",
      exitCode: 0,
    });

    const typo = await exec(strict, strictId, ["echo", "helo"]);

    expect(typo.exitCode).toBe(127);
    expect(typo.stderr).toContain('no entry of `commands` matches "echo helo"');
    expect(await exec(lenient, lenientId, ["echo", "helo"])).toMatchObject({
      exitCode: 0,
    });
  });

  test("the key '' does not stop a command in a local directory from running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-local-"));

    try {
      await using sandbox = localSandbox({
        commands: { hello: { stdout: "canned\n" }, "": {} },
        localDirs: [dir],
      });
      const id = await create(sandbox);
      const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, {
        command: ["pwd"],
        cwd: dir,
      });
      const { data } = (await response.json()) as { data: { stdout: string } };

      expect(Buffer.from(data.stdout, "base64").toString().trim()).toContain(
        dir,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a closed sandbox answers 503 and writes nothing", async () => {
    const sandbox = fakeSandbox();
    const id = await create(sandbox);

    await sandbox.close();

    const after = await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=/inngest/tools/x`,
      { method: "PUT", body: "x" },
    );

    expect(after.status).toBe(503);
  });

  test("an unknown Sandboxes API path is an error and never reaches the network", async () => {
    const network = vi.fn(async () => {
      return new Response("network");
    });
    const original = globalThis.fetch;

    globalThis.fetch = network as unknown as typeof fetch;

    try {
      await using sandbox = fakeSandbox();

      const unknown = await sandbox.fetch("http://sandboxes.test/v2/images");

      expect(unknown.status).toBe(404);
      expect(network).not.toHaveBeenCalled();

      // Other traffic of the client goes where it was going.
      await sandbox.fetch("http://dev.test/e/key");

      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("close kills the processes the agent started", async () => {
    const sandbox = localSandbox();
    const id = await create(sandbox);
    const started = await post(sandbox, `/v2/sandboxes/${id}/processes`, {
      command: ["sleep", "60"],
      cwd: "/work",
    });
    const { pid } = ((await started.json()) as { data: { pid: number } }).data;

    expect(() => process.kill(pid, 0)).not.toThrow();

    await sandbox.close();

    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });
});

describe("withKeys", () => {
  test("state() returns only the keys the agent set", async () => {
    const handle = withKeys({
      state: async () => {
        return { keys: { done: ["a"] }, status: "idle" };
      },
    } as never);

    expect(await handle.state()).toEqual({ done: ["a"] });
  });
});

describe.skipIf(!backendPath())("startGitRemote", () => {
  test("serves a repository for the token only, and leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-"));
    let remoteDir = "";

    try {
      await using remote = await startGitRemote("secret");

      remoteDir = remote.dir;

      const rejected = await fetch(
        `${remote.url}/info/refs?service=git-upload-pack`,
      );

      expect(rejected.status).toBe(401);

      // Asynchronous: the remote is served by this process, so a blocking
      // clone would wait for a server that cannot run.
      await promisify(execFile)(
        "git",
        [
          "clone",
          remote.url.replace("http://", "http://x-access-token:secret@"),
          "clone",
        ],
        { cwd: dir },
      );
      expect(
        execFileSync("git", ["log", "--oneline"], {
          cwd: `${dir}/clone`,
          encoding: "utf8",
        }),
      ).not.toBe("");
      expect(existsSync(remoteDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(existsSync(remoteDir)).toBe(false);
  });
});

describe.skipIf(!backendPath())("startGitRemote with repos", () => {
  const run = (cwd: string, ...args: string[]) => {
    return promisify(execFile)("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  };

  test("serves several seeded repositories, with branches, to anonymous readers; a push needs the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-repos-"));

    try {
      await using remote = await startGitRemote({
        token: "secret",
        anonymousReads: true,
        repos: {
          website: { "index.md": "site\n" },
          source: {
            main: { "a.ts": "export const a = 1;\n" },
            pr: { "a.ts": "export const a = 2;\n", "b.ts": "new\n" },
          },
        },
      });

      expect(Object.keys(remote.repos)).toEqual(["website", "source"]);
      expect(remote.url).toBe(remote.repos.website?.url);
      expect(Object.keys(remote.repos.source?.heads ?? {})).toEqual([
        "main",
        "pr",
      ]);

      // Anonymous clone of a branch, and of a commit by its hash.
      await run(dir, "clone", "--quiet", remote.repos.source?.url ?? "", "src");
      await run(`${dir}/src`, "checkout", "--quiet", "origin/pr");
      expect((await run(`${dir}/src`, "rev-parse", "HEAD")).stdout.trim()).toBe(
        remote.repos.source?.heads.pr,
      );
      // Any commit can be fetched by its hash.
      await run(dir, "init", "--quiet", "by-hash");
      await run(
        `${dir}/by-hash`,
        "fetch",
        "--quiet",
        remote.repos.source?.url ?? "",
        remote.repos.source?.heads.pr ?? "",
      );

      // A push without the token is refused, and the header is on record.
      await run(`${dir}/src`, "commit", "--allow-empty", "-m", "x", "-q");
      await expect(
        run(`${dir}/src`, "push", "--quiet", "origin", "HEAD:refs/heads/mine"),
      ).rejects.toThrow();
      expect(remote.pushAuth.length).toBeGreaterThan(0);

      // With the token it goes through.
      await run(
        `${dir}/src`,
        "push",
        "--quiet",
        remote.repos.source?.url.replace(
          "http://",
          "http://x-access-token:secret@",
        ) ?? "",
        "HEAD:refs/heads/mine",
      );
      expect(
        (
          await run(remote.repos.source?.dir ?? "", "rev-parse", "mine")
        ).stdout.trim(),
      ).not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without anonymousReads a clone needs the token too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-repos-"));

    try {
      await using remote = await startGitRemote({
        token: "secret",
        repos: { only: { "a.txt": "a\n" } },
      });

      await expect(
        run(dir, "clone", "--quiet", remote.url, "c"),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fakeSandbox /work, processes and disk paths", () => {
  const upload = (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    path: string,
    text: string,
  ) => {
    return sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: text },
    );
  };
  const execWith = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; stderr: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      stderr: Buffer.from(data.stderr, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("every sandbox has a /work of its own that commands run against for real", async () => {
    await using sandbox = localSandbox();
    const first = await create(sandbox);
    const second = await create(sandbox);

    await upload(sandbox, first, "/work/a.txt", "from first\n");

    expect(
      await execWith(sandbox, first, { command: ["cat", "/work/a.txt"] }),
    ).toMatchObject({ stdout: "from first\n", exitCode: 0 });
    // Not shared: the second sandbox has no such file.
    expect(
      (await execWith(sandbox, second, { command: ["cat", "/work/a.txt"] }))
        .exitCode,
    ).not.toBe(0);
  });

  test("a cwd or an environment value under /work runs for real, with SANDBOX_WORK set", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    await upload(sandbox, id, "/work/n.txt", "42\n");

    expect(
      await execWith(sandbox, id, {
        command: ["sh", "-c", "cat $FILE"],
        environment: { FILE: "/work/n.txt" },
      }),
    ).toMatchObject({ stdout: "42\n" });

    const where = await execWith(sandbox, id, {
      command: ["pwd"],
      cwd: "/work",
    });

    expect(where.stdout.trim()).toContain("fake-sandbox-work-");
    expect(
      (
        await execWith(sandbox, id, {
          command: ["sh", "-c", "echo $SANDBOX_WORK"],
        })
      ).exitCode,
    ).toBe(127);
    expect(
      (
        await execWith(sandbox, id, {
          command: ["sh", "-c", "echo $SANDBOX_WORK"],
          cwd: "/work",
        })
      ).stdout.trim(),
    ).toBe(where.stdout.trim());
  });

  test("a snapshot keeps /work and a sandbox made from it starts with it", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    await upload(sandbox, id, "/work/kept.txt", "kept\n");

    const snapshot = await post(sandbox, `/v2/sandboxes/${id}/snapshots`, {
      name: "s1",
    });
    const snapshotId = ((await snapshot.json()) as { data: { id: string } })
      .data.id;
    // Changes after the snapshot are not in it.
    await upload(sandbox, id, "/work/later.txt", "later\n");

    const restored = await post(sandbox, "/v2/sandboxes", { snapshotId });
    const restoredId = ((await restored.json()) as { data: { id: string } })
      .data.id;

    expect(
      await execWith(sandbox, restoredId, {
        command: ["cat", "/work/kept.txt"],
      }),
    ).toMatchObject({ stdout: "kept\n" });
    expect(
      (
        await execWith(sandbox, restoredId, {
          command: ["cat", "/work/later.txt"],
        })
      ).exitCode,
    ).not.toBe(0);
  });

  test("diskPaths are files of the sandbox's own that commands see", async () => {
    await using sandbox = localSandbox({ diskPaths: ["/tmp/ws.tgz"] });
    const first = await create(sandbox);
    const second = await create(sandbox);

    await upload(sandbox, first, "/tmp/ws.tgz", "tarball\n");

    expect(
      await execWith(sandbox, first, { command: ["cat", "/tmp/ws.tgz"] }),
    ).toMatchObject({ stdout: "tarball\n" });
    expect(
      (await execWith(sandbox, second, { command: ["cat", "/tmp/ws.tgz"] }))
        .exitCode,
    ).not.toBe(0);
  });

  test("processes keep their output and can be waited for; canned commands answer them too", async () => {
    await using sandbox = localSandbox({
      commands: { build: { stdout: "built\n", exitCode: 0 } },
    });
    const id = await create(sandbox);
    const start = async (body: Record<string, unknown>) => {
      const response = await post(
        sandbox,
        `/v2/sandboxes/${id}/processes`,
        body,
      );

      return ((await response.json()) as { data: { id: string } }).data.id;
    };
    const wait = async (processId: string) => {
      const response = await post(
        sandbox,
        `/v2/sandboxes/${id}/processes/${processId}/wait`,
        {},
      );

      return ((await response.json()) as { data: { exitCode: number } }).data
        .exitCode;
    };
    const output = async (processId: string) => {
      const response = await sandbox.fetch(
        `http://sandboxes.test/v2/sandboxes/${id}/processes/${processId}/output`,
      );
      const { data } = (await response.json()) as {
        data: { chunks: { stream: string; data: string }[] };
      };

      return data.chunks.map((chunk) => {
        return Buffer.from(chunk.data, "base64").toString();
      });
    };

    const real = await start({
      command: ["sh", "-c", "echo hi; exit 3"],
      cwd: "/work",
    });

    expect(await wait(real)).toBe(3);
    expect((await output(real))[0]).toBe("hi\n");

    const canned = await start({ command: ["build", "--all"] });

    expect(await wait(canned)).toBe(0);
    expect((await output(canned))[0]).toBe("built\n");

    const typo = await start({ command: ["biuld"] });

    expect(await wait(typo)).toBe(127);
    expect((await output(typo))[1]).toContain("no entry of `commands`");
  });
});

describe("fakeGitDataApi", () => {
  test("is seeded from a real repository, takes a commit through the API and shows the ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-api-"));
    const gitIn = (...args: string[]) => {
      return execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }).trim();
    };

    try {
      gitIn("init", "--quiet", "-b", "main");
      writeFileSync(join(dir, "a.txt"), "a\n");
      gitIn("add", ".");
      gitIn("commit", "--quiet", "-m", "base");

      const base = gitIn("rev-parse", "HEAD");
      const api = fakeGitDataApi({ repo: "acme/site" });

      api.seed(dir, base, "refs/heads/main");

      expect(api.ref("refs/heads/main")).toBe(base);
      expect(api.ref("refs/heads/agent")).toBeUndefined();

      const call = async (method: string, path: string, body?: unknown) => {
        const response = await api.fetch(
          `http://github.test/repos/acme/site${path}`,
          {
            method,
            headers: { authorization: "Bearer t" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );

        return (await response.json()) as {
          sha: string;
          tree: { sha: string };
        };
      };
      const blob = await call("POST", "/git/blobs", {
        content: Buffer.from("b\n").toString("base64"),
        encoding: "base64",
      });
      const baseCommit = await call("GET", `/git/commits/${base}`);
      const tree = await call("POST", "/git/trees", {
        base_tree: baseCommit.tree.sha,
        tree: [{ path: "b.txt", mode: "100644", type: "blob", sha: blob.sha }],
      });
      const who = {
        name: "t",
        email: "t@example.com",
        date: "2026-01-01T00:00:00Z",
      };
      const commit = await call("POST", "/git/commits", {
        message: "add b",
        tree: tree.sha,
        parents: [base],
        author: who,
        committer: who,
      });

      await call("POST", "/git/refs", {
        ref: "refs/heads/agent",
        sha: commit.sha,
      });

      expect(api.ref("refs/heads/agent")).toBe(commit.sha);
      expect(api.requests.map((r) => r.method)).toContain("POST");
      expect(api.requests[0]?.authorization).toBe("Bearer t");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fakeSandbox paths and processes in detail", () => {
  const exec = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; stderr: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("only /work itself is a host path: /workspace is not", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    const other = await exec(sandbox, id, { command: ["cat", "/workspace/x"] });

    // Not run on the host: it is not described, so it fails loudly.
    expect(other.exitCode).toBe(127);
  });

  test("a disk path is rewritten once and only as a whole path", async () => {
    await using sandbox = localSandbox({
      diskPaths: ["/data/"],
      commands: { "": {} },
    });
    const id = await create(sandbox);

    await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=/data/f.txt`,
      { method: "PUT", body: "disk\n" },
    );

    expect(
      await exec(sandbox, id, { command: ["cat", "/data/f.txt"] }),
    ).toMatchObject({ stdout: "disk\n" });
    // Another path that merely ends in /data is left alone: canned, not run.
    expect(
      await exec(sandbox, id, { command: ["cat", "/my/data/f.txt"] }),
    ).toMatchObject({ stdout: "", exitCode: 0 });
  });

  test("a process started from a script under /work runs, and close kills its children", async () => {
    const sandbox = localSandbox();
    const id = await create(sandbox);

    await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=/work/run.sh`,
      { method: "PUT", body: "#!/bin/sh\nsleep 60 &\nwait\n" },
    );
    await exec(sandbox, id, { command: ["chmod", "+x", "/work/run.sh"] });

    const started = await post(sandbox, `/v2/sandboxes/${id}/processes`, {
      command: ["/work/run.sh"],
    });
    const { pid } = ((await started.json()) as { data: { pid: number } }).data;

    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).not.toThrow();

    await sandbox.close();

    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });
});

describe.skipIf(!backendPath())("startGitRemote seeds", () => {
  test("a seed without main still gets one, and other branches start from it", async () => {
    await using remote = await startGitRemote({
      token: "t",
      repos: { only: { pr: { "a.txt": "a\n" } } },
    });

    expect(Object.keys(remote.repos.only?.heads ?? {})).toEqual(["main", "pr"]);
  });
});

describe("fakeSandbox host files and directories", () => {
  test("a file a command changed is read back as changed, not as uploaded", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const file = `http://sandboxes.test/v2/sandboxes/${id}/files?path=/work/x.txt`;

    await sandbox.fetch(file, { method: "PUT", body: "uploaded\n" });
    await post(sandbox, `/v2/sandboxes/${id}/exec`, {
      command: ["sh", "-c", "echo changed > /work/x.txt"],
    });

    expect(await (await sandbox.fetch(file)).text()).toBe("changed\n");
  });

  test("a disk directory works as a cwd before anything is uploaded, whether it is written with a slash or not", async () => {
    await using sandbox = localSandbox({ diskPaths: ["/data/"] });
    const id = await create(sandbox);
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, {
      command: ["sh", "-c", "echo hi > out.txt && cat out.txt"],
      cwd: "/data",
    });
    const { data } = (await response.json()) as {
      data: { stdout: string; exitCode: number };
    };

    expect(data.exitCode).toBe(0);
    expect(Buffer.from(data.stdout, "base64").toString()).toBe("hi\n");
  });

  test("diskPaths under /work are refused", () => {
    expect(() => {
      return localSandbox({ diskPaths: ["/work/sub"] });
    }).toThrow(/under \/work/);
  });

  test("localDirs match whole directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-dirs-"));
    const sibling = `${dir}-sibling`;

    try {
      await using sandbox = localSandbox({ localDirs: [dir] });
      const id = await create(sandbox);
      const response = (cwd: string) => {
        return post(sandbox, `/v2/sandboxes/${id}/exec`, {
          command: ["pwd"],
          cwd,
        });
      };

      mkdirSync(sibling);

      const inside = (await (await response(dir)).json()) as {
        data: { exitCode: number };
      };
      const beside = (await (await response(sibling)).json()) as {
        data: { exitCode: number };
      };

      expect(inside.data.exitCode).toBe(0);
      expect(beside.data.exitCode).toBe(127);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!backendPath())("startGitRemote names", () => {
  test("a repository name that needs URL encoding is served, and no repositories is an error", async () => {
    await expect(startGitRemote({ token: "t", repos: {} })).rejects.toThrow(
      /at least one repository/,
    );

    const dir = mkdtempSync(join(tmpdir(), "agents-testing-names-"));

    try {
      await using remote = await startGitRemote({
        token: "t",
        anonymousReads: true,
        repos: { "my repo": { "a.txt": "a\n" } },
      });

      await promisify(execFile)("git", ["clone", "--quiet", remote.url, "c"], {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      expect(existsSync(join(dir, "c", "a.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fakeSandbox cleanup", () => {
  test("a destroyed sandbox and a deleted snapshot free their host directories, and close frees the rest", async () => {
    const before = readdirSync(tmpdir()).filter((name) => {
      return (
        name.startsWith("fake-sandbox-") || name.startsWith("fake-snapshot-")
      );
    });
    const sandbox = localSandbox();
    const id = await create(sandbox);

    await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=/work/a.txt`,
      { method: "PUT", body: "a" },
    );

    const snapshot = await post(sandbox, `/v2/sandboxes/${id}/snapshots`, {});
    const snapshotId = ((await snapshot.json()) as { data: { id: string } })
      .data.id;
    const names = () => {
      return readdirSync(tmpdir()).filter((name) => {
        return (
          (name.startsWith("fake-sandbox-work-") ||
            name.startsWith("fake-snapshot-")) &&
          !before.includes(name)
        );
      });
    };

    expect(names()).toHaveLength(2);

    await sandbox.fetch(`http://sandboxes.test/v2/snapshots/${snapshotId}`, {
      method: "DELETE",
    });
    await sandbox.fetch(`http://sandboxes.test/v2/sandboxes/${id}`, {
      method: "DELETE",
    });

    expect(names()).toHaveLength(0);

    await sandbox.close();

    expect(
      readdirSync(tmpdir()).filter((name) => {
        return name.startsWith("fake-sandbox-tools-") && !before.includes(name);
      }),
    ).toHaveLength(0);
  });

  test("a runner file written to /tmp is removed on close", async () => {
    const sandbox = localSandbox();
    const id = await create(sandbox);
    const path = `/tmp/inngest-run-code-test-${Date.now()}.json`;

    await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: "{}" },
    );

    expect(existsSync(path)).toBe(true);

    await sandbox.close();

    expect(existsSync(path)).toBe(false);
  });
});

describe.skipIf(!backendPath())("startGitRemote auth for a push", () => {
  test("with anonymous reads the push discovery still needs the token, and a malformed path is a 400", async () => {
    await using remote = await startGitRemote({
      token: "t",
      anonymousReads: true,
    });

    const read = await fetch(`${remote.url}/info/refs?service=git-upload-pack`);
    const push = await fetch(
      `${remote.url}/info/refs?service=git-receive-pack`,
    );
    const bad = await fetch(`${remote.url}/%zz`);

    expect(read.status).toBe(200);
    expect(push.status).toBe(401);
    expect(bad.status).toBe(400);
    expect(remote.pushAuth).toHaveLength(1);
  });
});

describe("fakeSandbox real execution is opt-in and guarded", () => {
  const run = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; stderr: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      stderr: Buffer.from(data.stderr, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("by default nothing runs on the host, and the message says how to opt in", async () => {
    await using sandbox = fakeSandbox();
    const id = await create(sandbox);

    const touch = await run(sandbox, id, {
      command: ["sh", "-c", "echo x > /work/created"],
    });
    const tool = await run(sandbox, id, { command: ["/inngest/tools/run.sh"] });

    expect(touch.exitCode).toBe(127);
    expect(touch.stderr).toContain('execute: "local"');
    expect(tool.exitCode).toBe(127);
  });

  test("with the catch-all key and no execute, a command that mentions /work is answered, not run", async () => {
    await using sandbox = fakeSandbox({ commands: { "": {} } });
    const id = await create(sandbox);
    const ran = await run(sandbox, id, {
      command: ["sh", "-c", "echo ran > /work/marker"],
    });

    expect(ran).toMatchObject({ stdout: "", exitCode: 0 });

    const read = await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=/work/marker`,
    );

    expect(read.status).toBe(404);
  });

  test("rm -rf ~ stays inside the sandbox: HOME is its directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "agents-testing-home-"));
    const original = process.env.HOME;

    writeFileSync(join(home, "precious"), "keep\n");
    process.env.HOME = home;

    try {
      await using sandbox = localSandbox();
      const id = await create(sandbox);

      await run(sandbox, id, {
        command: ["sh", "-c", "cd /work && rm -rf ~"],
      });

      expect(existsSync(join(home, "precious"))).toBe(true);
    } finally {
      process.env.HOME = original;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a .. path segment is refused in a command, a cwd and an environment value", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    for (const body of [
      { command: ["cat", "/work/../../etc/hostname"] },
      { command: ["pwd"], cwd: "/work/../.." },
      {
        command: ["sh", "-c", "echo $X"],
        cwd: "/work",
        environment: { X: "/work/.." },
      },
    ]) {
      const refused = await run(sandbox, id, body);

      expect(refused.exitCode).toBe(126);
      expect(refused.stderr).toContain("refused to run on the host");
    }
  });

  test("an absolute path outside the sandbox is refused, one inside is not", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    for (const command of [
      ["cat", "/etc/hostname"],
      ["sh", "-c", "ls /tmp/anything"],
      ["ls", "/"],
    ]) {
      const refused = await run(sandbox, id, { command, cwd: "/work" });

      expect(refused.exitCode).toBe(126);
      expect(refused.stderr).toContain("outside the sandbox's directories");
    }

    expect(
      (await run(sandbox, id, { command: ["ls", "/work"], cwd: "/work" }))
        .exitCode,
    ).toBe(0);
  });

  test("the host environment is not passed, except PATH and what passEnv names", async () => {
    process.env.FAKE_SANDBOX_SECRET = "s3cret";

    try {
      await using plain = localSandbox();
      await using passing = localSandbox({ passEnv: ["FAKE_SANDBOX_SECRET"] });
      const plainId = await create(plain);
      const passingId = await create(passing);
      const body = {
        command: ["sh", "-c", 'echo "[$FAKE_SANDBOX_SECRET]"'],
        cwd: "/work",
      };

      expect((await run(plain, plainId, body)).stdout).toBe("[]\n");
      expect((await run(passing, passingId, body)).stdout).toBe("[s3cret]\n");
    } finally {
      delete process.env.FAKE_SANDBOX_SECRET;
    }
  });

  test("uploads and reads cannot leave the sandbox's directories", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const evil = join(tmpdir(), `fake-sandbox-evil-${Date.now()}`);
    const put = await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=${encodeURIComponent(`/work/../..${evil}`)}`,
      { method: "PUT", body: "x" },
    );
    const read = await sandbox.fetch(
      `http://sandboxes.test/v2/sandboxes/${id}/files?path=${encodeURIComponent("/work/../../../../etc/hostname")}`,
    );

    expect(put.status).toBe(400);
    expect(existsSync(evil)).toBe(false);
    expect(read.status).toBe(404);
  });

  test("~/work and /work.bak are not rewritten as /work", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const dir = (
      await run(sandbox, id, {
        command: ["sh", "-c", "echo $SANDBOX_WORK"],
        cwd: "/work",
      })
    ).stdout.trim();
    const home = await run(sandbox, id, {
      command: ["sh", "-c", "echo ~/work"],
      cwd: "/work",
    });
    const backup = await run(sandbox, id, {
      command: ["cat", "/work.bak"],
      cwd: "/work",
    });

    // The shell expands ~ to the sandbox directory (HOME): the text `~/work`
    // was left alone, not turned into `~<dir>`.
    expect(home.stdout.trim()).toBe(`${dir}/work`);
    // /work.bak is not /work, so it is not moved: it is a path outside.
    expect(backup.exitCode).toBe(126);
  });

  test("a process that would break out is refused too", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const started = await post(sandbox, `/v2/sandboxes/${id}/processes`, {
      command: ["cat", "/etc/hostname"],
      cwd: "/work",
    });
    const { id: processId } = (
      (await started.json()) as {
        data: { id: string };
      }
    ).data;
    const waited = await post(
      sandbox,
      `/v2/sandboxes/${id}/processes/${processId}/wait`,
      {},
    );

    expect(
      ((await waited.json()) as { data: { exitCode: number } }).data.exitCode,
    ).toBe(126);
  });
});

describe("fakeSandbox guard details", () => {
  const exec = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; stderr: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      stderr: Buffer.from(data.stderr, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("a refusal is recorded with its reason, so a test can assert on it", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    await exec(sandbox, id, {
      command: ["cat", "/etc/hostname"],
      cwd: "/work",
    });

    expect(sandbox.posts({ method: "sandbox.refused" })).toMatchObject([
      { body: { command: ["cat", "/etc/hostname"] } },
    ]);
  });

  test("slashes that are not paths do not trip the guard, and /tmp is a place to work from, not to act on", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    // A division, and a `/q` that is a sed command, are not paths.
    expect(
      (
        await exec(sandbox, id, {
          command: [
            "sh",
            "-c",
            "printf 'a\\nb\\n' | sed '1q'; echo $((4 / 2))",
          ],
          cwd: "/work",
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await exec(sandbox, id, {
          command: ["sh", "-c", "pwd # /work"],
          cwd: "/tmp",
        })
      ).exitCode,
    ).toBe(0);
    // Naming /tmp as something to act on is a path outside.
    expect(
      (await exec(sandbox, id, { command: ["ls", "/tmp"], cwd: "/work" }))
        .exitCode,
    ).toBe(126);
  });
});

describe("fakeSandbox guard against shell tricks", () => {
  const exec = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; stderr: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("a command with no cwd, or a relative one, works from the sandbox's directory, not the host process's", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const home = (
      await exec(sandbox, id, {
        command: ["sh", "-c", "echo $SANDBOX_WORK"],
        cwd: "/work",
      })
    ).stdout.trim();

    // The marker "/work" names the sandbox; the cwd is not given.
    expect(
      (
        await exec(sandbox, id, { command: ["sh", "-c", "pwd # /work"] })
      ).stdout.trim(),
    ).toBe(home);
    expect(
      (
        await exec(sandbox, id, {
          command: ["sh", "-c", "pwd # /work"],
          cwd: "sub/dir",
        })
      ).stdout.trim(),
    ).toBe(`${home}/sub/dir`);
  });

  test("each of these is refused", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const attempts = [
      "cat file:///etc/passwd # /work",
      "x://;cat</etc/passwd # /work",
      "cat \\/etc/passwd # /work",
      "cat {/etc/passwd,x} # /work",
      "cat ~root/.ssh/id_rsa # /work",
      "cat /*/passwd # /work",
      "cat /?tc/passwd # /work",
      "cd .\\. # /work",
      "cd .'.' # /work",
      'cd ."." # /work',
      "cat /proc/self/root/etc/passwd # /work",
      "cat /dev/fd/../etc/passwd # /work",
    ];

    for (const script of attempts) {
      const refused = await exec(sandbox, id, {
        command: ["sh", "-c", script],
      });

      expect({ script, exitCode: refused.exitCode }).toEqual({
        script,
        exitCode: 126,
      });
    }
  });
});

describe("fakeSandbox guard: the root, /tmp and data words", () => {
  // The commands here only read, so a guard that failed would show it without
  // damage; the refusal of the destructive forms is the same code path.
  const exec = async (
    sandbox: ReturnType<typeof fakeSandbox>,
    id: string,
    body: Record<string, unknown>,
  ) => {
    const response = await post(sandbox, `/v2/sandboxes/${id}/exec`, body);
    const { data } = (await response.json()) as {
      data: { stdout: string; exitCode: number };
    };

    return {
      stdout: Buffer.from(data.stdout, "base64").toString(),
      exitCode: data.exitCode,
    };
  };

  test("the root directory, or everything in it, is refused as a target", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);

    for (const script of [
      "ls -d /*",
      "cat /*.conf",
      "find / -maxdepth 0",
      "du -s /",
      "cd / && cat etc/hostname",
    ]) {
      const refused = await exec(sandbox, id, {
        command: ["sh", "-c", `${script} # /work`],
      });

      expect({ script, exitCode: refused.exitCode }).toEqual({
        script,
        exitCode: 126,
      });
    }
  });

  test("a command run with cwd /tmp works in the sandbox's directory, not the host's /tmp", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const home = (
      await exec(sandbox, id, {
        command: ["sh", "-c", "echo $SANDBOX_WORK"],
        cwd: "/work",
      })
    ).stdout.trim();
    const there = await exec(sandbox, id, {
      command: ["sh", "-c", "pwd # /work"],
      cwd: "/tmp",
    });

    expect(there.stdout.trim()).toBe(home);
  });

  test("the words that are data are not searched for paths, but a whole word that is a path is checked", async () => {
    await using sandbox = localSandbox();
    const id = await create(sandbox);
    const data = await exec(sandbox, id, {
      command: [
        "sh",
        "-c",
        'printf "%s" "$1" # /work',
        "sh",
        "fix /api/users/list and (~flag)",
      ],
    });

    expect(data).toMatchObject({
      stdout: "fix /api/users/list and (~flag)",
      exitCode: 0,
    });
    expect(
      (
        await exec(sandbox, id, {
          command: ["cat", "/api/users/list"],
          cwd: "/work",
        })
      ).exitCode,
    ).toBe(126);
  });
});
