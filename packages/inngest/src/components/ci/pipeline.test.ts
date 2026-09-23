import { describe, expect, test } from "vitest";
import { memoryCacheStore } from "./cache.ts";
import { $ } from "./command.ts";
import { createCi } from "./createCi.ts";
import { CiUsageError, CommandFailedError } from "./errors.ts";
import { sandbox } from "./extraMachine.ts";
import { consoleReporter } from "./github/auth.ts";
import { files } from "./helpers.ts";
import { from } from "./machine.ts";
import { report } from "./report.ts";
import {
  createCiTestClient,
  createFakeSandboxApi,
  runFunction,
} from "./testHelpers.ts";
import type { CacheStore } from "./types.ts";

const prEvent = {
  name: "github/pull_request.opened",
  data: {
    action: "opened",
    number: 7,
    repository: { full_name: "inngest/inngest-js" },
    pull_request: {
      number: 7,
      head: {
        sha: "abc1234",
        ref: "feature",
        repo: { full_name: "inngest/inngest-js" },
      },
      base: { sha: "def5678", ref: "main" },
    },
    _github: { event: "pull_request", installationId: 1 },
  },
};

const prTrigger = [{ event: "github/pull_request.opened" }];

const setup = (
  opts: {
    cacheStore?: CacheStore;
    api?: ReturnType<typeof createFakeSandboxApi>;
  } = {},
) => {
  const api = opts.api ?? createFakeSandboxApi();
  const client = createCiTestClient(api);
  const reporter = consoleReporter();

  const ci = createCi(client, {
    github: reporter,
    cacheStore: opts.cacheStore ?? memoryCacheStore(),
    runUrl: ({ runId }) => `http://localhost:8288/run?runID=${runId}`,
  });

  return { api, client, ci, reporter };
};

describe("pipelines and jobs", () => {
  test("a job runs its commands on its own machine", async () => {
    const { api, ci } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm install`;
      await $`pnpm test`;
      return "done";
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe("done");
    expect(api.commands).toEqual([
      ["pnpm", "install"],
      ["pnpm", "test"],
    ]);
    expect(api.sandboxes.size).toBe(1);
    expect([...api.sandboxes.values()][0]?.name).toBe("ci-01TESTRUN-test");
  });

  test("a job with no commands never creates a machine", async () => {
    const { api, ci } = setup();

    const deploy = ci.job("deploy", async () => ({ url: "https://preview" }));

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      deploy(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toEqual({ url: "https://preview" });
    expect(api.sandboxes.size).toBe(0);
  });

  test("two callers share one job run", async () => {
    const { api, ci } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm build`;
      return "built";
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const [a, b] = await Promise.all([build(), build()]);
      return { a, b };
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ a: "built", b: "built" });
    // One machine and one command, however many callers there were.
    expect(api.sandboxes.size).toBe(1);
    expect(api.commands.filter((argv) => argv[1] === "build")).toHaveLength(1);
  });

  test("step IDs inside a job are scoped to it", async () => {
    const { ci } = setup();

    const one = ci.job("one", async () => {
      await $`echo one`;
    });
    const two = ci.job("two", async () => {
      await $`echo two`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await one();
      await two();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.stepIds).toContain("one › machine");
    expect(result.stepIds).toContain("two › machine");
    expect(result.stepIds.some((id) => id.startsWith("one › echo one"))).toBe(
      true,
    );
    expect(result.stepIds.some((id) => id.startsWith("two › echo two"))).toBe(
      true,
    );
  });

  test("repeating a command adds a counter to its step ID", async () => {
    const { ci } = setup();

    const job = ci.job("build", async () => {
      await $`pnpm build`;
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });
    const buildSteps = result.stepIds.filter((id) =>
      id.startsWith("build › pnpm build"),
    );

    expect(buildSteps.some((id) => id.includes("#2"))).toBe(true);
  });

  test("`.as()` names the step", async () => {
    const { ci } = setup();

    const job = ci.job("build", async () => {
      await $`pnpm build --filter web`.as("build web");
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.stepIds.some((id) => id.includes("build › build web"))).toBe(
      true,
    );
  });

  test("a job called outside a pipeline throws", async () => {
    const { ci } = setup();
    const job = ci.job("test", async () => undefined);

    await expect(job()).rejects.toBeInstanceOf(CiUsageError);
  });

  test("`$` outside a job explains what to do", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "Wrap it in `ci.job()`",
    );
  });
});

describe("commands", () => {
  test("a non-zero exit fails the job with its output", async () => {
    const { api, ci } = setup();
    api.script([{ match: "pnpm test", exitCode: 1, stderr: "1 test failed" }]);

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "`pnpm test` exited with 1",
    );
  });

  test("`.nothrow()` returns the exit code instead", async () => {
    const { api, ci } = setup();
    api.script([{ match: "pnpm lint", exitCode: 3, stdout: "nope" }]);

    const job = ci.job("lint", async () => {
      const result = await $`pnpm lint`.nothrow();
      return result.exitCode;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe(3);
  });

  test("`.text()` reads stdout", async () => {
    const { api, ci } = setup();
    api.script([{ match: "git rev-parse", stdout: "abc1234\n" }]);

    const job = ci.job("sha", async () => $`git rev-parse HEAD`.text());

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    expect((await runFunction(pipeline, { event: prEvent })).data).toBe(
      "abc1234",
    );
  });

  test("`.lines()` and `.json()` parse stdout", async () => {
    const { api, ci } = setup();
    api.script([
      { match: "list", stdout: "a\nb\n" },
      { match: "config", stdout: '{"ok":true}' },
    ]);

    const job = ci.job("read", async () => ({
      lines: await $`list`.lines(),
      json: await $`config`.json<{ ok: boolean }>(),
    }));

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    expect((await runFunction(pipeline, { event: prEvent })).data).toEqual({
      lines: ["a", "b"],
      json: { ok: true },
    });
  });

  test("`.retries()` reruns a failing command as new steps", async () => {
    const { api, ci } = setup();
    api.script([{ match: "flaky", exitCode: 1, stderr: "flake" }]);

    const job = ci.job("test", async () => {
      await $`flaky`.retries(1);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(result.stepIds.some((id) => id.includes("#attempt-1"))).toBe(true);
    expect(result.stepIds.some((id) => id.includes("#attempt-2"))).toBe(true);
  });

  test("a command that needs several polls still completes", async () => {
    const { api, ci } = setup();
    api.script([{ match: "slow", ticks: 3, stdout: "eventually" }]);

    const job = ci.job("slow", async () => $`slow`.text());

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("eventually");
    expect(result.stepIds.filter((id) => id.includes("wait #")).length).toBe(4);
  });

  test("a short command with a timeout runs as one captured step", async () => {
    const { api, ci } = setup();
    api.script([{ match: "quick", stdout: "fast" }]);

    const job = ci.job("quick", async () => $`quick`.timeout("30s").text());

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("fast");
    expect(api.requests.some((request) => request.endsWith("/exec"))).toBe(
      true,
    );
    expect(result.stepIds.some((id) => id.includes("wait #"))).toBe(false);
  });

  test("secrets are masked in output and never in step input", async () => {
    const { api, ci } = setup();
    api.script([{ match: "publish", stdout: "used npm_s3cret to publish" }]);

    const job = ci.job("release", async () => {
      const result = await $`publish`.withSecret("NPM_TOKEN", "npm_s3cret");
      return result.stdout;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("used *** to publish");
    expect(JSON.stringify(result.steps)).not.toContain("npm_s3cret");
  });

  test("a background process can be waited on and killed", async () => {
    const { api, ci } = setup();
    api.script([{ match: "serve", ticks: 1, stdout: "listening" }]);

    const job = ci.job("e2e", async () => {
      const server = await $`serve`.background();
      const output = await server.output();
      await server.kill();
      return output;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("listening");
    expect(api.requests.some((request) => request.includes("/signals"))).toBe(
      true,
    );
  });

  test("a command with no output reads as empty", async () => {
    const { ci } = setup();

    const job = ci.job("quiet", async () => {
      const result = await $`true`;
      return { exitCode: result.exitCode, stdout: result.stdout };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    expect((await runFunction(pipeline, { event: prEvent })).data).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });

  test("an ambiguous start adopts the process that did start", async () => {
    const { api, ci } = setup();
    api.script([
      { match: "first", stdout: "one" },
      { match: "second", stdout: "two", ambiguousStarts: 1 },
      { match: "server", stdout: "up", ambiguousStarts: 1 },
    ]);

    const job = ci.job("reconcile", async () => {
      const first = await $`first`.text();
      const second = await $`second`.text();
      const server = await $`server`.background();
      return { first, second, server: await server.output() };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ first: "one", second: "two", server: "up" });
    // Each start ran once: reconciling never starts the command again.
    expect(api.commands.map((argv) => argv.join(" "))).toEqual([
      "first",
      "second",
      "server",
    ]);
    expect(
      result.stepIds.filter((id) => id.endsWith("reconcile")),
    ).toHaveLength(2);
  });

  test("an ambiguous start with nothing to adopt still fails", async () => {
    const api = createFakeSandboxApi();
    api.script([{ match: "gone", ambiguousStarts: 1 }]);
    // The process the 409 was about doesn't show up in the list.
    const fetch = api.fetch;
    api.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 409) {
        api.processes.clear();
      }
      return response;
    };
    const { ci } = setup({ api });

    const job = ci.job("lost", async () => {
      await $`gone`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("operation_ambiguous");
  });
});

describe("from()", () => {
  test("snapshots the parent once and clones per child", async () => {
    const { api, ci } = setup();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;
      return "installed";
    });

    const lint = ci.job("lint", async () => {
      const parent = await from(install);
      await $`pnpm lint`;
      return parent;
    });

    const test = ci.job("test", async () => {
      await from(install);
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const [lintResult] = await Promise.all([lint(), test()]);
      return lintResult;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("installed");
    expect(api.snapshots.size).toBe(1);
    expect(api.sandboxes.size).toBe(3);

    const cloned = [...api.sandboxes.values()].filter(
      (sandbox) => sandbox.snapshotId,
    );
    expect(cloned).toHaveLength(2);
  });

  test("from() after a command throws", async () => {
    const { ci } = setup();

    const parent = ci.job("parent", async () => undefined);
    const child = ci.job("child", async () => {
      await $`echo hi`;
      await from(parent);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      child(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "must come before this job's first command",
    );
  });

  test("from() twice throws", async () => {
    const { ci } = setup();

    const a = ci.job("a", async () => undefined);
    const b = ci.job("b", async () => undefined);
    const child = ci.job("child", async () => {
      await from(a);
      await from(b);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      child(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "can only be called once",
    );
  });

  test("falls back to a fresh machine when snapshots aren't available", async () => {
    const { api, ci } = setup();
    api.disableSnapshots();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const test = ci.job("test", async () => {
      await from(install);
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      test(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(2);
    expect(
      [...api.sandboxes.values()].every((sandbox) => !sandbox.snapshotId),
    ).toBe(true);
  });
});

describe("machines", () => {
  test("a finished job's machine is paused, and destroyed with the run", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    await runFunction(pipeline, { event: prEvent });

    expect(api.requests.some((request) => request.includes("/pause"))).toBe(
      true,
    );
    expect(
      [...api.sandboxes.values()].every(
        (sandbox) => sandbox.status === "TERMINATED",
      ),
    ).toBe(true);
  });

  test("vcpu picks the matching memory", async () => {
    const { api, ci } = setup();

    const job = ci.job({ id: "big", machine: { vcpu: 4 } }, async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    await runFunction(pipeline, { event: prEvent });

    expect([...api.sandboxes.values()][0]).toMatchObject({
      vcpu: 4,
      memoryMb: 4096,
    });
  });

  test("an extra machine gets its own sandbox and scope", async () => {
    const { api, ci } = setup();

    const job = ci.job("e2e", async () => {
      const api2 = await sandbox("api");
      await api2.$`pnpm start`;
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(2);
    expect(
      result.stepIds.some((id) => id.startsWith("e2e › api › pnpm start")),
    ).toBe(true);
  });

  test("an extra machine's url() explains it isn't supported", async () => {
    const { ci } = setup();

    const job = ci.job("e2e", async () => {
      const extra = await sandbox("api");
      return extra.url(3000);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "Machines can't reach each other yet",
    );
  });
});

describe("matrix", () => {
  test("every combination runs as its own job", async () => {
    const { api, ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test --node ${node}`;
        return node;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      compat(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["20", "22"]);
    expect(api.sandboxes.size).toBe(2);
    expect(
      result.stepIds.some((id) => id.startsWith("compat (node:20) › machine")),
    ).toBe(true);
  });

  test("a matrix can run one combination", async () => {
    const { api, ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test`;
        return node;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      compat({ node: "22" }),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["22"]);
    expect(api.sandboxes.size).toBe(1);
  });
});

describe("cache", () => {
  test("a second run restores the job and skips its commands", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });
    const build = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
        return "built";
      },
    );

    const firstPipeline = first.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => build(),
    );

    expect((await runFunction(firstPipeline, { event: prEvent })).data).toBe(
      "built",
    );
    expect(first.api.commands).toHaveLength(1);

    const second = setup({ cacheStore: store, api });
    const build2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
        return "built again";
      },
    );

    const secondPipeline = second.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => build2(),
    );

    const result = await runFunction(secondPipeline, { event: prEvent });

    expect(result.data).toBe("built");
    // Nothing new ran: no extra commands, and no second machine.
    expect(api.commands).toHaveLength(1);
    expect(api.sandboxes.size).toBe(1);
  });

  test("a changed key misses and runs again", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });
    const job1 = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
        return 1;
      },
    );
    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => job1()),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });
    const job2 = second.ci.job(
      { id: "setup", cache: { key: "v2" } },
      async () => {
        await $`pnpm install`;
        return 2;
      },
    );

    const result = await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => job2()),
      { event: prEvent },
    );

    expect(result.data).toBe(2);
    expect(api.commands).toHaveLength(2);
  });

  test("a cached job with a machine can still be started from", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });
    const setupJob = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
        return "installed";
      },
    );
    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => setupJob()),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });
    const setupJob2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
        return "installed";
      },
    );
    const test = second.ci.job("test", async () => {
      await from(setupJob2);
      await $`pnpm test`;
    });

    const result = await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => test()),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    // `setup` was restored, so only the child job's command ran this time.
    expect(api.commands).toEqual([
      ["pnpm", "install"],
      ["pnpm", "test"],
    ]);
    // …and the child cloned the cached snapshot rather than starting fresh.
    expect(
      [...api.sandboxes.values()].filter((machine) => machine.snapshotId),
    ).toHaveLength(1);
  });

  test("files() keys are resolved through the repository", async () => {
    expect(files("pnpm-lock.yaml", ".nvmrc")).toEqual({
      kind: "inngest/ci.cacheKeyPart",
      type: "files",
      patterns: ["pnpm-lock.yaml", ".nvmrc"],
    });
  });
});

describe("checks", () => {
  test("the pipeline check always completes, even with no jobs", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      ci.skip("no relevant changes"),
    );

    await runFunction(pipeline, { event: prEvent });

    const completed = reporter.history.filter(
      (entry) => entry.status === "completed",
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      name: "pr",
      conclusion: "success",
      title: "Nothing to do: no relevant changes",
    });
  });

  test("a failing job fails its own check and the pipeline check", async () => {
    const { api, ci, reporter } = setup();
    api.script([{ match: "pnpm test", exitCode: 1, stderr: "boom" }]);

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      test(),
    );

    await runFunction(pipeline, { event: prEvent });

    const completed = reporter.history.filter(
      (entry) => entry.status === "completed",
    );

    expect(completed).toEqual([
      expect.objectContaining({
        name: "pr / test",
        conclusion: "failure",
        title: "`pnpm test` exited with 1",
      }),
      expect.objectContaining({ name: "pr", conclusion: "failure" }),
    ]);
  });

  test("a cache hit reads as restored, never skipped", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });
    const job1 = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );
    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => job1()),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });
    const job2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );
    await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => job2()),
      { event: prEvent },
    );

    const restored = second.reporter.history.find(
      (entry) => entry.name === "pr / setup" && entry.status === "completed",
    );

    expect(restored?.conclusion).toBe("success");
    expect(restored?.title).toMatch(/^Restored, built /);
  });

  test("job checks can be turned off for the whole pipeline", async () => {
    const { ci, reporter } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: { jobs: false } },
      async () => job(),
    );

    await runFunction(pipeline, { event: prEvent });

    expect(reporter.history.every((entry) => entry.name === "pr")).toBe(true);
  });

  test("checks can be turned off entirely", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => undefined,
    );

    await runFunction(pipeline, { event: prEvent });

    expect(reporter.history).toHaveLength(0);
  });

  test("report.summary adds to the job's check", async () => {
    const { ci } = setup();

    const job = ci.job("test", async () => {
      await report.summary("Coverage: **91%**");
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () =>
      job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("test › report:summary");
  });
});

describe("errors", () => {
  test("CommandFailedError carries the command and output", () => {
    const error = new CommandFailedError({
      command: ["pnpm", "test"],
      exitCode: 1,
      stdoutTail: "out",
      stderrTail: "err",
      jobPath: "test",
    });

    expect(error.message).toContain("`pnpm test` exited with 1");
    expect(error.jobPath).toBe("test");
  });
});
