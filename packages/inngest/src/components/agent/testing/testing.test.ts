/**
 * @module
 * The testing entry: the scripted model plays its script, the fakes server
 * keeps every call it is sent, the fake sandbox answers from memory and
 * cleans up after itself, a command nobody described fails, and the git
 * remote asks for its token and leaves nothing behind.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as entry from "../../../experimental/agents/testing.ts";
import {
  fakeSandbox,
  script,
  startFakes,
  startGitRemote,
  withKeys,
} from "../../../experimental/agents/testing.ts";
import { backendPath } from "./gitRemote.ts";

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
      "fakeSandbox",
      "script",
      "startFakes",
      "startGitRemote",
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
    const sandbox = fakeSandbox();
    const id = await create(sandbox);
    const started = await post(sandbox, `/v2/sandboxes/${id}/processes`, {
      command: ["sleep", "60"],
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
