/**
 * Tests of what only a local run does: `ci.local`, the run-job function, and
 * the messages sent to the CLI. Messages are caught by a real loopback server.
 *
 * @module
 */

import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryCacheStore } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { consoleReporter } from "../github/auth.ts";
import { repo } from "../github/helpers.ts";
import { $ } from "../machine/command.ts";
import { from } from "../machine/from.ts";
import { type createCi, createCiWithStore } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { fakeSchema } from "../testing/schema.ts";
import type { CacheStore } from "../types.ts";
import type { LocalMessage, RunJobEventData } from "./protocol.ts";
import { localEnv, runJobEvent, runJobFunctionId } from "./protocol.ts";

const prTrigger = [{ event: "github/pull_request.opened" }];

const runJobData = (
  data: Pick<RunJobEventData, "job"> & Partial<RunJobEventData>,
) => {
  return {
    name: runJobEvent,
    data: {
      repository: { full_name: "inngest/inngest-js" },
      pull_request: { head: { sha: "abc1234", ref: "feature" } },
      local: { path: "/repo", baseRef: "main" },
      ...data,
    },
  };
};

const setup = (
  opts: {
    api?: ReturnType<typeof createFakeSandboxApi>;
    cacheStore?: CacheStore;
  } = {},
) => {
  const api = opts.api ?? createFakeSandboxApi();

  const ci = createCiWithStore(
    createCiTestClient(api),
    {
      github: consoleReporter(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    },
    opts.cacheStore ?? memoryCacheStore(),
  );

  return { api, ci };
};

/** The function `ci.functions()` returns for `id`, if it does. */
const functionFor = (ci: ReturnType<typeof createCi>, id: string) => {
  return ci.functions().find((fn) => {
    return fn.opts.id === id;
  });
};

const servers: Server[] = [];

/** Point the app's reporter at a loopback server that keeps what it's sent. */
const listen = async (): Promise<LocalMessage[]> => {
  const messages: LocalMessage[] = [];

  const server = createServer((req, res) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      messages.push(JSON.parse(body) as LocalMessage);

      res.writeHead(204).end();
    });
  });

  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  vi.stubEnv(localEnv.reporterUrl, `http://127.0.0.1:${port}`);

  return messages;
};

const kinds = (messages: LocalMessage[], kind: LocalMessage["kind"]) => {
  return messages.filter((message) => {
    return message.kind === kind;
  });
};

afterEach(async () => {
  vi.unstubAllEnvs();

  await Promise.all(
    servers.splice(0).map((server) => {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    }),
  );
});

describe("without INNGEST_CI_LOCAL", () => {
  test("ci.local is false and there is no run-job function", () => {
    const { ci } = setup();

    expect(ci.local).toBe(false);
    expect(functionFor(ci, runJobFunctionId)).toBeUndefined();
  });

  test("nothing is sent without a reporter URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { ci } = setup();

    ci.job("test", async () => {
      await $`pnpm test`;
    });

    ci.functions();

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe("with INNGEST_CI_LOCAL", () => {
  test("ci.local is true and the run-job function is served", () => {
    vi.stubEnv(localEnv.local, "1");

    const { ci } = setup();

    expect(ci.local).toBe(true);
    expect(functionFor(ci, runJobFunctionId)).toBeDefined();

    // A cancelled run-job run, like Ctrl-C, still gets its machines destroyed.
    expect(functionFor(ci, `${runJobFunctionId}/cleanup`)).toBeDefined();
  });
});

describe("job IDs", () => {
  test("defining a job ID twice throws", () => {
    const { ci } = setup();

    ci.job("test", async () => {
      return 1;
    });

    expect(() => {
      return ci.job("test", async () => {
        return 2;
      });
    }).toThrow(CiUsageError);

    expect(() => {
      return ci.job("test", async () => {
        return 2;
      });
    }).toThrow(/unique.*"test"/);
  });

  test("a matrix and a curried job factory register their jobs on every run", async () => {
    const { ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async () => {
        return "ok";
      },
    );

    const build = (target: string) => {
      return ci.job(`build ${target}`, async () => {
        return target;
      });
    };

    const pr = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return [await compat(), await build("web")()];
    });

    for (let run = 0; run < 2; run++) {
      const result = await runFunction(pr, {
        event: { name: "github/pull_request.opened", data: {} },
      });

      expect(result.type).toBe("function-resolved");
    }
  });
});

describe("the manifest", () => {
  test("lists pipelines, jobs and matrices once everything is defined", async () => {
    const messages = await listen();
    const { ci } = setup();

    ci.job("lint", async () => {
      return undefined;
    });

    ci.job("greet", async (name: string) => {
      return name;
    });

    ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async () => {
        return undefined;
      },
    );

    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"], os: ["linux", "mac"] },
        exclude: [{ os: "mac" }],
        include: [{ node: "22", os: "mac" }],
      },
      async () => {
        return undefined;
      },
    );

    ci.pipeline(
      {
        id: "pr",
        on: [...prTrigger, { cron: "0 0 * * *" }],
      },
      async () => {
        return undefined;
      },
    );

    ci.pipeline(
      {
        id: "deploy",
        on: ci.manual({
          pipelineId: "deploy",
          schema: fakeSchema<{ target: string }>({ target: "string" }),
        }),
      },
      async () => {
        return undefined;
      },
    );

    ci.pipeline(
      {
        id: "readme",
        on: ci.manual({
          pipelineId: "readme",
          schema: {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: (value: unknown) => {
                return { value };
              },
            },
          },
        }),
      },
      async () => {
        return undefined;
      },
    );

    ci.functions();
    ci.functions();

    // A job defined after `functions()` is still in the manifest.
    ci.job("test", async () => {
      return undefined;
    });

    await vi.waitFor(() => {
      expect(messages).toHaveLength(1);
    });

    expect(messages).toEqual([
      {
        kind: "manifest",
        manifest: {
          pipelines: [
            {
              id: "pr",
              triggers: [
                { event: "github/pull_request.opened" },
                { cron: "0 0 * * *" },
              ],
            },
            {
              id: "deploy",
              triggers: [
                {
                  event: "ci/manual.deploy",
                  schema: {
                    type: "object",
                    properties: { target: { type: "string" } },
                    required: ["target"],
                  },
                },
              ],
            },
            // A schema that can't be written as JSON Schema sends none.
            { id: "readme", triggers: [{ event: "ci/manual.readme" }] },
          ],
          jobs: [
            { id: "lint", takesInput: false },
            { id: "greet", takesInput: true },
            {
              id: "build",
              takesInput: false,
              input: {
                type: "object",
                properties: { target: { type: "string" } },
                required: ["target"],
              },
            },
            { id: "test", takesInput: false },
          ],
          matrices: [
            {
              id: "compat",
              axes: { node: ["20", "22"], os: ["linux", "mac"] },
              // The real expansion: `exclude` removed every mac and `include` added one back.
              combos: [
                { node: "20", os: "linux" },
                { node: "22", os: "linux" },
                { node: "22", os: "mac" },
              ],
            },
          ],
        },
      },
    ]);
  });
});

describe("the run-job function", () => {
  const setupLocal = () => {
    vi.stubEnv(localEnv.local, "1");

    return setup();
  };

  test("runs a job with its input", async () => {
    const { ci } = setupLocal();

    ci.job("greet", async (name: string) => {
      return `hello ${name}`;
    });

    const fn = functionFor(ci, runJobFunctionId);

    const result = await runFunction(fn as never, {
      event: runJobData({ job: "greet", input: "jack" }),
    });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe("hello jack");
  });

  test("derives the repository context the way a pull request run does", async () => {
    const { ci } = setupLocal();

    ci.job("who", async () => {
      return repo();
    });

    const result = await runFunction(
      functionFor(ci, runJobFunctionId) as never,
      { event: runJobData({ job: "who" }) },
    );

    expect(result.data).toMatchObject({
      owner: "inngest",
      sha: "abc1234",
      ref: "feature",
    });
  });

  test("runs the combinations it is given, or all of them", async () => {
    const { ci } = setupLocal();

    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"], os: ["linux", "mac"] },
        exclude: [{ os: "mac" }],
        include: [{ node: "22", os: "mac" }],
      },
      async ({ node, os }) => {
        return `${node} ${os}`;
      },
    );

    const fn = functionFor(ci, runJobFunctionId);

    const some = await runFunction(fn as never, {
      event: runJobData({
        job: "compat",
        combos: [
          { node: "22", os: "linux" },
          { node: "22", os: "mac" },
          // Excluded, so it isn't a combination and doesn't run.
          { node: "20", os: "mac" },
        ],
      }),
    });

    expect(some.data).toEqual(["22 linux", "22 mac"]);

    const all = await runFunction(fn as never, {
      event: runJobData({ job: "compat" }),
    });

    expect(all.data).toEqual(["20 linux", "22 linux", "22 mac"]);
  });

  test("runs a subset of a matrix in one run, each combination as its own job", async () => {
    const messages = await listen();
    const { ci } = setupLocal();

    ci.matrix(
      { id: "compat", axes: { node: ["20", "22", "24"] }, concurrency: 1 },
      async ({ node }) => {
        await $`node --version`;

        return node;
      },
    );

    const result = await runFunction(
      functionFor(ci, runJobFunctionId) as never,
      {
        event: runJobData({
          job: "compat",
          combos: [{ node: "20" }, { node: "24" }],
        }),
      },
    );

    expect(result.data).toEqual(["20", "24"]);

    await vi.waitFor(() => {
      expect(
        new Set(
          kinds(messages, "job").map((message) => {
            return message.kind === "job" ? message.jobId : "";
          }),
        ),
      ).toEqual(new Set(["compat (node:20)", "compat (node:24)"]));
    });
  });

  test("an unknown job is a usage error", async () => {
    const { ci } = setupLocal();

    const result = await runFunction(
      functionFor(ci, runJobFunctionId) as never,
      {
        event: runJobData({ job: "nope" }),
      },
    );

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);
    expect(String((result.error as Error).message)).toContain('"nope"');
  });

  test("reports the run, the job and its commands, each once", async () => {
    const messages = await listen();
    const { ci } = setupLocal();

    ci.job("test", async () => {
      await $`pnpm install`;

      await $`pnpm test`;
    });

    ci.job("lint", async () => {
      return undefined;
    });

    await runFunction(functionFor(ci, runJobFunctionId) as never, {
      event: runJobData({ job: "test" }),
    });

    await vi.waitFor(() => {
      expect(kinds(messages, "run")).toHaveLength(2);
    });

    const summary = messages
      .filter((message) => {
        return message.kind !== "manifest";
      })
      .map((message) => {
        switch (message.kind) {
          case "run":
            return `run ${message.pipelineId} ${message.status}`;
          case "job":
            return `job ${message.jobId} ${message.status}`;
          case "activity":
            return `activity ${message.jobId} ${message.text}`;
          case "command":
            return `command ${message.name} #${message.attempt} ${message.status}`;
        }
      });

    expect(summary).toEqual([
      "run ci-run-job running",
      "job test running",
      "command pnpm install #1 running",
      "activity test creating machine…",
      "command pnpm install #1 passed",
      "command pnpm test #1 running",
      "command pnpm test #1 passed",
      "job test passed",
      "activity test pausing machine…",
      "run ci-run-job passed",
    ]);
  });

  test("a failed command reports its exit code and output", async () => {
    const messages = await listen();
    const { api, ci } = setupLocal();

    api.script([
      { match: "pnpm test", exitCode: 1, stdout: "one\ntwo", stderr: "boom" },
    ]);

    ci.job("test", async () => {
      await $`pnpm test`;
    });

    await runFunction(functionFor(ci, runJobFunctionId) as never, {
      event: runJobData({ job: "test" }),
    });

    await vi.waitFor(() => {
      expect(kinds(messages, "run")).toHaveLength(2);
    });

    expect(kinds(messages, "command").at(-1)).toMatchObject({
      status: "failed",
      exitCode: 1,
      outputTail: "one\ntwo\nboom",
    });

    expect(kinds(messages, "job").at(-1)).toMatchObject({
      jobId: "test",
      status: "failed",
      title: "`pnpm test` exited with 1",
    });

    expect(kinds(messages, "run").at(-1)).toMatchObject({
      status: "failed",
      reason: "test: `pnpm test` exited with 1",
    });
  });
});

describe("what a job says while it starts from a parent", () => {
  const defineJobs = (
    ci: ReturnType<typeof createCi>,
    opts: { cache: boolean; commands: boolean },
  ) => {
    const base = ci.job(
      { id: "base", ...(opts.cache ? { cache: { key: "v1" } } : {}) },
      async () => {
        if (opts.commands) {
          await $`pnpm install`;
        }
      },
    );

    ci.job("child", async () => {
      await from(base);

      await $`pnpm test`;
    });
  };

  const runChild = async (ci: ReturnType<typeof createCi>) => {
    return runFunction(functionFor(ci, runJobFunctionId) as never, {
      event: runJobData({ job: "child" }),
    });
  };

  const activities = (messages: LocalMessage[]): string[] => {
    return messages.flatMap((message) => {
      return message.kind === "activity" && message.jobId === "child"
        ? [message.text]
        : [];
    });
  };

  const run = async (
    opts: {
      cache: boolean;
      commands?: boolean;
      api?: ReturnType<typeof createFakeSandboxApi>;
      cacheStore?: CacheStore;
    },
    prepare?: (api: ReturnType<typeof createFakeSandboxApi>) => void,
  ) => {
    vi.stubEnv(localEnv.local, "1");

    const messages = await listen();
    const { api, ci } = setup({
      ...(opts.api ? { api: opts.api } : {}),
      ...(opts.cacheStore ? { cacheStore: opts.cacheStore } : {}),
    });

    prepare?.(api);

    defineJobs(ci, { cache: opts.cache, commands: opts.commands ?? true });

    const result = await runChild(ci);

    await vi.waitFor(() => {
      expect(kinds(messages, "run").length).toBeGreaterThan(1);
    });

    return { api, result, texts: activities(messages) };
  };

  test("a snapshot from this run says so", async () => {
    const { texts } = await run({ cache: false });

    expect(texts).toContain("waiting for base…");
    expect(texts).toContain("starting base");
  });

  test("a cached snapshot says how old it is", async () => {
    const api = createFakeSandboxApi();
    const cacheStore = memoryCacheStore();

    await run({ cache: true, api, cacheStore });

    const { texts } = await run({ cache: true, api, cacheStore });

    expect(texts).toContain("waiting for base…");

    expect(
      texts.some((text) => {
        return /^starting base · cached (just now|.+ ago)$/.test(text);
      }),
    ).toBe(true);
  });

  test("a cached entry with no snapshot says it is rebuilding", async () => {
    const api = createFakeSandboxApi();
    const cacheStore = memoryCacheStore();

    await run({ cache: true, commands: false, api, cacheStore });

    const { texts } = await run({
      cache: true,
      commands: false,
      api,
      cacheStore,
    });

    expect(texts).toContain("rebuilding base · no cache");
  });

  test("unavailable snapshots say so", async () => {
    const { texts } = await run({ cache: false }, (api) => {
      api.disableSnapshots();
    });

    expect(texts).toContain("rebuilding base · no snapshots");
  });

  test("a cached snapshot that won't start is rebuilt and its entry invalidated", async () => {
    const api = createFakeSandboxApi();
    const inner = memoryCacheStore();
    const writes: { invalid?: boolean }[] = [];
    const cacheStore: CacheStore = {
      get: inner.get,
      set: async (key, entry) => {
        writes.push(entry);

        await inner.set(key, entry);
      },
    };

    await run({ cache: true, api, cacheStore });

    api.commands.length = 0;
    api.failSnapshotStarts();

    const { result, texts } = await run({ cache: true, api, cacheStore });

    expect(result.type).toBe("function-resolved");
    expect(texts).toContain("rebuilding base · bad snapshot");

    const ran = api.commands.map((argv) => {
      return argv.join(" ");
    });

    expect(
      ran.some((command) => {
        return command.includes("pnpm install");
      }),
    ).toBe(true);

    expect(
      writes.filter((entry) => {
        return entry.invalid;
      }),
    ).toHaveLength(1);

    expect(writes.at(-1)?.invalid).toBeUndefined();
  });

  describe("three jobs starting from one cached parent", () => {
    const runAll = async (opts: { bad: boolean }) => {
      vi.stubEnv(localEnv.local, "1");

      const api = createFakeSandboxApi();
      const inner = memoryCacheStore();
      const writes: { invalid?: boolean; snapshotId?: string }[] = [];
      const cacheStore: CacheStore = {
        get: inner.get,
        set: async (key, entry) => {
          writes.push(entry);

          await inner.set(key, entry);
        },
      };

      const define = (ci: ReturnType<typeof createCi>) => {
        const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
          await $`pnpm install`;
        });

        const children = ["one", "two", "three"].map((id) => {
          return ci.job(id, async () => {
            await from(base);

            await $`pnpm test ${id}`;
          });
        });

        return ci.job("all", async () => {
          await Promise.all(
            children.map((child) => {
              return child();
            }),
          );
        });
      };

      const first = setup({ api, cacheStore });

      define(first.ci);

      await runFunction(functionFor(first.ci, runJobFunctionId) as never, {
        event: runJobData({ job: "all" }),
      });

      const cachedSnapshot = [...api.snapshots.keys()][0] as string;

      if (opts.bad) {
        api.failSnapshotStarts();
      }

      api.commands.length = 0;
      api.snapshotStarts.length = 0;
      writes.length = 0;

      const messages = await listen();
      const second = setup({ api, cacheStore });

      define(second.ci);

      const result = await runFunction(
        functionFor(second.ci, runJobFunctionId) as never,
        { event: runJobData({ job: "all" }) },
      );

      await vi.waitFor(() => {
        expect(kinds(messages, "run").length).toBeGreaterThan(1);
      });

      const texts = (jobId: string) => {
        return messages.flatMap((message) => {
          return message.kind === "activity" && message.jobId === jobId
            ? [message.text]
            : [];
        });
      };

      return { api, result, writes, cachedSnapshot, texts };
    };

    test("a bad snapshot is tried once and the parent rebuilt once", async () => {
      const { api, result, writes, cachedSnapshot, texts } = await runAll({
        bad: true,
      });

      expect(result.type).toBe("function-resolved");

      const attempts = api.snapshotStarts.filter((id) => {
        return id === cachedSnapshot;
      });

      expect(attempts).toHaveLength(1);

      const installs = api.commands.filter((argv) => {
        return argv.join(" ") === "pnpm install";
      });

      expect(installs).toHaveLength(1);

      const fresh = [...api.snapshots.keys()].find((id) => {
        return id !== cachedSnapshot;
      });

      expect(fresh).toBeDefined();

      expect(
        [...api.sandboxes.values()].filter((machine) => {
          return machine.snapshotId === fresh;
        }),
      ).toHaveLength(3);

      expect(
        writes.filter((entry) => {
          return entry.invalid;
        }),
      ).toHaveLength(1);

      expect(writes.at(-1)).toMatchObject({ snapshotId: fresh });

      const lines = ["one", "two", "three"].map(texts);

      const rebuilding = lines.filter((line) => {
        return line.includes("rebuilding base · bad snapshot");
      });

      expect(rebuilding).toHaveLength(1);

      for (const line of lines) {
        expect(line.indexOf("waiting for base…")).toBeGreaterThanOrEqual(0);
        expect(line.indexOf("waiting for base…")).toBeLessThan(
          line.lastIndexOf("starting base"),
        );
      }
    });

    test("the child that probed the bad snapshot recovers under a new name and its stuck machine is destroyed", async () => {
      const { api, result } = await runAll({ bad: true });

      expect(result.type).toBe("function-resolved");

      const stuck = [...api.sandboxes.values()].filter((machine) => {
        return machine.stuck;
      });

      expect(stuck).toHaveLength(1);
      expect(stuck[0]?.status).toBe("TERMINATED");

      expect(
        [...api.sandboxes.values()].filter((machine) => {
          return machine.name.endsWith("one-retry");
        }),
      ).toHaveLength(1);

      expect(
        [...api.sandboxes.values()].filter((machine) => {
          return machine.status === "STARTING";
        }),
      ).toHaveLength(0);
    });

    test("a good snapshot costs no extra machines or rebuilds", async () => {
      const { api, result, cachedSnapshot, texts } = await runAll({
        bad: false,
      });

      expect(result.type).toBe("function-resolved");

      expect(api.snapshotStarts).toEqual([
        cachedSnapshot,
        cachedSnapshot,
        cachedSnapshot,
      ]);

      expect(
        api.commands.filter((argv) => {
          return argv.join(" ") === "pnpm install";
        }),
      ).toHaveLength(0);

      expect(
        [...api.sandboxes.values()].filter((machine) => {
          return machine.snapshotId;
        }),
      ).toHaveLength(6);

      // Three children from each run, and base's own machine from the first.
      expect(api.sandboxes.size).toBe(7);

      for (const id of ["one", "two", "three"]) {
        expect(texts(id).join("|")).not.toContain("rebuilding");
      }
    });
  });
});

describe("a cached job built in its own run", () => {
  test("reports its jobs and commands under the pipeline's job, with its own run's URL", async () => {
    vi.stubEnv(localEnv.local, "1");

    const messages = await listen();
    const { ci } = setup();

    ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const result = await runFunction(
      functionFor(ci, runJobFunctionId) as never,
      {
        event: runJobData({ job: "base" }),
      },
    );

    await vi.waitFor(() => {
      expect(kinds(messages, "command").length).toBeGreaterThan(0);
    });

    expect(result.type).toBe("function-resolved");

    // The build's own run is never a run of the session.
    const runs = kinds(messages, "run") as Extract<
      LocalMessage,
      { kind: "run" }
    >[];

    expect(
      new Set(
        runs.map((message) => {
          return message.pipelineId;
        }),
      ),
    ).toEqual(new Set([runJobFunctionId]));

    const runIds = new Set(
      messages.flatMap((message) => {
        return message.kind === "manifest" ? [] : [message.runId];
      }),
    );

    expect(runIds).toEqual(new Set(["01TESTRUN"]));

    const command = messages.find((message) => {
      return message.kind === "command";
    });

    expect(command).toMatchObject({ jobId: "base", name: "pnpm install" });

    expect(
      messages.some((message) => {
        return (
          message.kind === "job" &&
          message.jobId === "base" &&
          /runID=01TESTINVOKED\d+/.test(message.url ?? "")
        );
      }),
    ).toBe(true);

    expect(
      messages.some((message) => {
        return (
          message.kind === "activity" &&
          message.jobId === "base" &&
          message.text === "building in its own run"
        );
      }),
    ).toBe(true);
  });
});
