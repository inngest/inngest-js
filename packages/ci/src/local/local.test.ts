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
import { CiUsageError } from "../errors.ts";
import { consoleReporter } from "../github/auth.ts";
import { repo } from "../github/helpers.ts";
import { $ } from "../machine/command.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { LocalMessage, RunJobEventData } from "./protocol.ts";
import {
  localEnv,
  localTargetKey,
  runJobEvent,
  runJobFunctionId,
} from "./protocol.ts";

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
    /** Shared by clients that stand for later runs in one environment. */
    api?: ReturnType<typeof createFakeSandboxApi>;
  } = {},
) => {
  const api = opts.api ?? createFakeSandboxApi();

  const ci = createCi(createCiTestClient(api), {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

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

describe("the manifest", () => {
  test("lists pipelines, jobs and matrices once everything is defined", async () => {
    const messages = await listen();
    const { ci } = setup();

    ci.job("lint", async () => {
      return undefined;
    });

    ci.job("greet", async (name: string) => {
      await $`echo ${name}`;
    });

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
          ],
          jobs: [
            { id: "lint", takesInput: false },
            { id: "greet", takesInput: true },
            { id: "test", takesInput: false },
          ],
          matrices: [
            {
              id: "compat",
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
    const received = new Set<string>();

    ci.job("greet", async (name: string) => {
      received.add(name);
    });

    const fn = functionFor(ci, runJobFunctionId);

    const result = await runFunction(fn as never, {
      event: runJobData({ job: "greet", input: "jack" }),
    });

    expect(result.type).toBe("function-resolved");
    expect([...received]).toEqual(["jack"]);
  });

  test("derives the repository context the way a pull request run does", async () => {
    const { ci } = setupLocal();
    const seen: unknown[] = [];

    ci.job("who", async () => {
      seen.push(repo());
    });

    await runFunction(functionFor(ci, runJobFunctionId) as never, {
      event: runJobData({ job: "who" }),
    });

    expect(seen.length).toBeGreaterThan(0);

    expect(seen[0]).toMatchObject({
      owner: "inngest",
      sha: "abc1234",
      ref: "feature",
    });
  });

  test("runs the combinations it is given, or all of them", async () => {
    const { ci } = setupLocal();
    let ran = new Set<string>();

    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"], os: ["linux", "mac"] },
        exclude: [{ os: "mac" }],
        include: [{ node: "22", os: "mac" }],
      },
      async ({ node, os }) => {
        ran.add(`${node} ${os}`);
      },
    );

    const fn = functionFor(ci, runJobFunctionId);

    await runFunction(fn as never, {
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

    expect([...ran].sort()).toEqual(["22 linux", "22 mac"]);

    ran = new Set();

    await runFunction(fn as never, {
      event: runJobData({ job: "compat" }),
    });

    expect([...ran].sort()).toEqual(["20 linux", "22 linux", "22 mac"]);
  });

  test("runs a subset of a matrix in one run, each combination as its own job", async () => {
    const messages = await listen();
    const { ci } = setupLocal();

    ci.matrix(
      { id: "compat", axes: { node: ["20", "22", "24"] }, concurrency: 1 },
      async () => {
        await $`node --version`;
      },
    );

    await runFunction(functionFor(ci, runJobFunctionId) as never, {
      event: runJobData({
        job: "compat",
        combos: [{ node: "20" }, { node: "24" }],
      }),
    });

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
          case "warning":
            return `warning ${message.text}`;
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

describe("a local run's target", () => {
  const twoPipelines = () => {
    const { ci } = setup();
    const ran = new Set<string>();

    const pr = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      ran.add("pr");
    });

    const docs = ci.pipeline({ id: "docs", on: prTrigger }, async () => {
      ran.add("docs");
    });

    return { ran, pr, docs };
  };

  const eventFor = (target: string) => {
    return {
      name: "github/pull_request.opened",
      data: { [localTargetKey]: target },
    };
  };

  test("only the pipeline the event names runs", async () => {
    vi.stubEnv(localEnv.local, "1");

    const { ran, pr, docs } = twoPipelines();

    const skipped = await runFunction(pr, { event: eventFor("docs") });
    const target = await runFunction(docs, { event: eventFor("docs") });

    expect(skipped).toMatchObject({
      type: "function-resolved",
      data: { skipped: "not the target" },
    });

    expect(Object.keys(skipped.steps ?? {})).toEqual([]);
    expect(target.type).toBe("function-resolved");
    expect([...ran]).toEqual(["docs"]);
  });

  test("every pipeline runs when the event names none", async () => {
    vi.stubEnv(localEnv.local, "1");

    const { ran, pr, docs } = twoPipelines();
    const event = { name: "github/pull_request.opened", data: {} };

    await runFunction(pr, { event });
    await runFunction(docs, { event });

    expect([...ran]).toEqual(["pr", "docs"]);
  });

  test("outside a local run the target is ignored", async () => {
    const { ran, pr } = twoPipelines();

    await runFunction(pr, { event: eventFor("docs") });

    expect([...ran]).toEqual(["pr"]);
  });
});
