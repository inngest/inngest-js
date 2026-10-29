/**
 * @module
 * The testing entry: the scripted model plays its script, the fakes server
 * keeps every call it is sent, the thread helper returns the keys the agent
 * set, and the git remote asks for its token.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  backendPath,
  fakeSandbox,
  git,
  script,
  startFakes,
  startGitRemote,
  withKeys,
} from "../../../experimental/agents/testing.ts";

const request = (turn: number, last = "hello") => {
  return {
    messages: [{ role: "user" as const, content: last }],
    turn,
    maxTurns: 10,
    tools: [],
  };
};

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
    const fakes = await startFakes();

    try {
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
    } finally {
      await fakes.close();
    }
  });
});

describe("fakeSandbox", () => {
  test("answers the Sandboxes API from memory and reports to the fakes", async () => {
    const fakes = await startFakes();

    try {
      const { fetch: sandboxFetch } = fakeSandbox({
        recordUrl: fakes.url,
        commands: { hello: { stdout: "world" } },
      });

      const created = await sandboxFetch("http://sandboxes.test/v2/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(created.status).toBeLessThan(300);
      // The operations are reported without being waited for.
      await vi.waitFor(() => {
        expect(fakes.posts({ method: "sandbox.create" })).toHaveLength(1);
      });
    } finally {
      await fakes.close();
    }
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

describe.skipIf(!backendPath)("startGitRemote", () => {
  test("serves a repository for the token only", async () => {
    const remote = await startGitRemote("secret");
    const dir = mkdtempSync(join(tmpdir(), "agents-testing-"));

    try {
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
      expect(git(`${dir}/clone`, "log", "--oneline")).not.toBe("");
    } finally {
      await remote.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
