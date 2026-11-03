/**
 * @module
 * Tests for a sandbox definition's `repo`: the tools it adds, the order of
 * checkout and setup, a function-valued repo, which token goes where, and the
 * result and errors of the one push the host makes.
 */
import { describe, expect, test, vi } from "vitest";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { secret } from "../../../components/sandbox/secret.ts";
import type {
  DurableSandbox,
  DurableSandboxTools,
} from "../../../components/sandbox/types.ts";

vi.mock("./gitPush.ts", () => {
  return { pushBranch: vi.fn() };
});

import {
  openSandboxes,
  resolveSandboxes,
  type SandboxRuntime,
  sandbox,
} from "./defs.ts";
import { pushBranch } from "./gitPush.ts";
import { createRepo, mintRepoToken, PushRefusedError } from "./repo.ts";

const pushed = vi.mocked(pushBranch);

const fakeEnvironment = () => {
  const order: string[] = [];
  const environments: Record<string, string>[] = [];
  const created = vi.fn(async () => {
    return {
      commands: {
        run: async (
          id: unknown,
          command: unknown,
          options?: { environment?: Record<string, string> },
        ) => {
          const key = typeof id === "string" ? id : (id as { id: string }).id;

          order.push(key);
          environments.push(options?.environment ?? {});

          return key.endsWith("repo:checkout")
            ? { stdout: "repo:cloned:abc123\n", stderr: "", exitCode: 0 }
            : { stdout: String(command), stderr: "", exitCode: 0 };
        },
      },
      files: {},
      destroy: async () => {},
    } as unknown as DurableSandbox;
  });
  const runtime = {
    run: async (id: string, fn: () => Promise<unknown>) => {
      order.push(`step:${id}`);

      return fn();
    },
  } as SandboxRuntime;

  return {
    order,
    environments,
    runtime,
    sandboxes: { create: created } as unknown as DurableSandboxTools,
  };
};

const auth = {
  read: () => {
    return "read-token";
  },
  write: () => {
    return "write-token";
  },
};

describe("the model's push tool", () => {
  test("work_push appears only with a repo, and not with push: false", () => {
    const env = fakeEnvironment();
    const plain = sandbox({ id: "plain", tools: sandbox.tools.defaults });
    const withRepo = sandbox({
      id: "w",
      tools: sandbox.tools.defaults,
      repo: { url: "acme/app", auth },
    });
    const noPush = sandbox({
      id: "n",
      tools: sandbox.tools.defaults,
      repo: { url: "acme/app", push: false },
    });
    const opened = openSandboxes(
      { plain, withRepo, noPush },
      env.sandboxes,
      env.runtime,
    );
    const names = Object.values(opened).flatMap((each) => {
      return Object.keys(each.tools);
    });

    expect(names).toEqual([
      "plain_run",
      "withRepo_run",
      "withRepo_push",
      "noPush_run",
    ]);
    expect(opened.plain?.repo).toBeUndefined();
    expect(opened.withRepo?.repo?.path).toBe("/work");
    expect(opened.noPush?.repo).toBeDefined();
  });
});

describe("the checkout", () => {
  test("runs first, then setup, with the read token minted inside a step", async () => {
    const env = fakeEnvironment();
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app", auth },
      setup: async ({ sandbox: box }) => {
        await box.commands.run("install", ["npm", "i"]);
      },
    });
    const opened = openSandboxes({ work }, env.sandboxes, env.runtime);

    await opened.work?.commands.run("first", ["ls"]);

    expect(env.order.slice(0, 3)).toEqual([
      "step:work:repo:token",
      "work:repo:checkout",
      "work:setup:sandbox:install",
    ]);
    expect(env.environments[0]?.GIT_TOKEN).toBe("read-token");
  });

  test("the write token appears in no command the sandbox saw", async () => {
    const env = fakeEnvironment();
    const work = sandbox({ id: "work", repo: { url: "acme/app", auth } });
    const opened = openSandboxes({ work }, env.sandboxes, env.runtime);

    await opened.work?.commands.run("first", ["ls"]);

    expect(JSON.stringify(env.environments)).not.toContain("write-token");
    expect(JSON.stringify(env.order)).not.toContain("write-token");
  });

  test("a function-valued repo is evaluated once per run from the event", async () => {
    const env = fakeEnvironment();
    const work = sandbox({
      id: "work",
      repo: ({ event }) => {
        const data = event.data as { head: string };

        return { url: "acme/app", ref: data.head, path: "/src" };
      },
    });
    const bindings = await resolveSandboxes(
      { work },
      {
        event: { name: "pr/opened", data: { head: "fix-1" } },
        thread: { key: "t" },
      },
    );
    const opened = openSandboxes(bindings, env.sandboxes, env.runtime);

    await opened.work?.commands.run("first", ["ls"]);

    expect(env.environments[0]).toMatchObject({ REF: "fix-1", DIR: "/src" });
    expect(opened.work?.repo?.path).toBe("/src");
  });

  test("the shell of a new thread starts at the checkout path", async () => {
    const env = fakeEnvironment();
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app", path: "/src" },
    });
    const opened = openSandboxes({ work }, env.sandboxes, env.runtime);

    expect(await opened.work?.place.load()).toEqual({
      cwd: "/src",
      env: {},
      unset: [],
    });
  });
});

describe("mintRepoToken", () => {
  test("a single secret serves both kinds of access", async () => {
    process.env.REPO_TEST_TOKEN = "one";

    const only = secret("REPO_TEST_TOKEN");

    expect(await mintRepoToken(only, "read")).toBe("one");
    expect(await mintRepoToken(only, "write")).toBe("one");
  });

  test("{ read, write } takes a secret for each, and a secret prints as its name", async () => {
    process.env.REPO_READ_TOKEN = "r";
    process.env.REPO_WRITE_TOKEN = "w";

    const auth = {
      read: secret("REPO_READ_TOKEN"),
      write: secret("REPO_WRITE_TOKEN"),
    };

    expect(await mintRepoToken(auth, "read")).toBe("r");
    expect(await mintRepoToken(auth, "write")).toBe("w");
    expect(String(auth.write)).toBe("[secret REPO_WRITE_TOKEN]");
    expect(JSON.stringify(auth)).not.toContain('w"');
  });

  test("a function is told the access, and { read, write } picks one", async () => {
    const asked: string[] = [];
    const fn = ({ access }: { access: string }) => {
      asked.push(access);

      return `t-${access}`;
    };

    expect(await mintRepoToken(fn, "read")).toBe("t-read");
    expect(await mintRepoToken({ read: fn, write: fn }, "write")).toBe(
      "t-write",
    );
    expect(await mintRepoToken(undefined, "read")).toBeUndefined();
    expect(asked).toEqual(["read", "write"]);
  });
});

describe("repo.push", () => {
  const handle = () => {
    const runs: unknown[] = [];

    return {
      runs,
      sandbox: {
        commands: {
          run: async (...args: unknown[]) => {
            runs.push(args);

            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
        files: {},
      } as never,
    };
  };

  test("returns the first pushed ref as one result, with the policy's notes", async () => {
    pushed.mockResolvedValueOnce({
      ok: true,
      pushed: [{ ref: "refs/heads/fix", sha: "f00d", notes: ["checked"] }],
    });

    const { sandbox: box, runs } = handle();
    const repo = createRepo(box, { url: "acme/app", path: "/work", auth });
    const result = await repo.push("fix");

    expect(result).toEqual({ branch: "fix", sha: "f00d", notes: ["checked"] });
    expect(pushed.mock.calls.at(-1)?.[3]).toEqual({
      idempotencyKey: "repo-push:fix",
    });
    expect(pushed.mock.calls.at(-1)?.[1]).toMatchObject({
      remote: "https://github.com/acme/app",
      cwd: "/work",
    });
    expect(runs).toHaveLength(1);
  });

  test("the write token is minted by the push, for write access", async () => {
    pushed.mockResolvedValueOnce({
      ok: true,
      pushed: [{ ref: "refs/heads/fix", sha: "f00d" }],
    });

    const { sandbox: box } = handle();

    await createRepo(box, { url: "acme/app", path: "/work", auth }).push("fix");

    const options = pushed.mock.calls.at(-1)?.[1];

    expect(await (options?.token as () => Promise<string>)()).toBe(
      "write-token",
    );
  });

  test("a refusal throws PushRefusedError, which is not retried", async () => {
    pushed.mockResolvedValueOnce({
      ok: false,
      error: "refused: no main",
      refused: "no main",
    });

    const { sandbox: box } = handle();
    const caught = await createRepo(box, {
      url: "acme/app",
      path: "/work",
      auth,
    })
      .push("main")
      .catch((error: unknown) => {
        return error;
      });

    expect(caught).toBeInstanceOf(PushRefusedError);
    expect(caught).toBeInstanceOf(NonRetriableError);
    expect((caught as PushRefusedError).reason).toBe("no main");
  });

  test("a repo with no auth cannot push", async () => {
    const { sandbox: box } = handle();

    await expect(
      createRepo(box, { url: "acme/app", path: "/work" }).push("fix"),
    ).rejects.toThrow(/no auth/);
  });
});

describe("the model's push result", () => {
  test("a refusal comes back as an error result, not a throw", async () => {
    pushed.mockResolvedValueOnce({
      ok: false,
      error: "refused: no main",
      refused: "no main",
    });

    const env = fakeEnvironment();
    const work = sandbox({
      id: "work",
      repo: { url: "acme/app", auth },
    });
    const opened = openSandboxes({ work }, env.sandboxes, env.runtime);
    const tool = opened.work?.tools.work_push as unknown as {
      run: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    const result = await tool.run({ branch: "main" }, {});

    expect(JSON.stringify(result)).toContain("refused: no main");
  });
});
