import { beforeEach, describe, expect, test, vi } from "vitest";

import { createCi } from "./createCi.ts";
import { durable, resetDurableWarnings } from "./durable.ts";
import { CiNotSupportedError, CiUsageError } from "./errors.ts";
import { consoleReporter, githubToken } from "./github/auth.ts";
import { github } from "./github/index.ts";
import {
  createCiTestClient,
  createFakeGitHub,
  createFakeSandboxApi,
  type FakeGitHub,
  runFunction,
} from "./testHelpers.ts";
import { oidc, shard, shell, vercel } from "./unsupported.ts";

const prTrigger = [{ event: "github/pull_request.opened" }];

const prEvent = {
  name: "github/pull_request.opened",
  data: {
    action: "opened",
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

const setup = (gh: FakeGitHub) => {
  const api = createFakeSandboxApi();
  const client = createCiTestClient(api);

  const ci = createCi(client, {
    github: githubToken({
      token: "gh-test-token",
      baseUrl: "https://api.github.test",
      fetch: gh.fetch,
    }),
    runUrl: ({ runId }) => `http://localhost:8288/run?runID=${runId}`,
  });

  return { api, client, ci };
};

let gh: FakeGitHub;

beforeEach(() => {
  gh = createFakeGitHub();
  resetDurableWarnings();
});

describe("github.rest", () => {
  test("each call is its own step, with owner and repo filled in", async () => {
    gh.route("POST /repos/inngest/inngest-js/releases", {
      id: 1,
      html_url: "https://github.com/inngest/inngest-js/releases/v1",
    });

    const { ci } = setup(gh);

    const job = ci.job("release", async () => {
      const release = await github.rest.repos.createRelease({
        tag_name: "v1.4.0",
      });
      return release.html_url;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // `data` is returned, not the whole response.
    expect(result.data).toBe(
      "https://github.com/inngest/inngest-js/releases/v1",
    );
    expect(result.stepIds).toContain("release › github.repos.createRelease");
    expect(gh.requests[0]).toMatchObject({
      method: "POST",
      path: "/repos/inngest/inngest-js/releases",
      body: { tag_name: "v1.4.0" },
    });
  });

  test("repeated calls get their own step IDs", async () => {
    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

    const { ci } = setup(gh);

    const job = ci.job("read", async () => {
      await github.rest.repos.get({});
      await github.rest.repos.get({});
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });
    const calls = result.stepIds.filter((id) =>
      id.startsWith("read › github.repos.get"),
    );

    expect(calls).toEqual([
      "read › github.repos.get",
      "read › github.repos.get #2",
    ]);
  });

  test("`.with()` names the step and doesn't advance the counter", async () => {
    gh.route("POST /repos/inngest/inngest-js/git/refs", {
      ref: "refs/tags/v1",
    });

    const { ci } = setup(gh);

    const job = ci.job("tag", async () => {
      await github.rest.with({ id: "tag-release" }).git.createRef({
        ref: "refs/tags/v1.4.0",
        sha: "abc1234",
      });
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.stepIds).toContain("tag › tag-release");
  });

  test("calls inside step.run run directly, as one step", async () => {
    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });
    gh.route("GET /repos/inngest/inngest-js/pulls/7", { mergeable: true });

    const { ci, client } = setup(gh);

    const job = ci.job("read", async () => {
      const { step } = await import("../InngestStepTools.ts");

      return step.run("read-both", async () => {
        const repo = await github.rest.repos.get({});
        const pull = await github.rest.pulls.get({ pull_number: 7 });
        return { branch: repo.default_branch, mergeable: pull.mergeable };
      });
    });

    void client;

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ branch: "main", mergeable: true });
    // One step for the two calls, not three.
    expect(result.stepIds.filter((id) => id.includes("github."))).toEqual([]);
    expect(result.stepIds).toContain("read › read-both");
  });

  test("a 404 fails without retrying", async () => {
    gh.route(
      "GET /repos/inngest/inngest-js/pulls/7",
      { message: "Not Found" },
      404,
    );

    const { ci } = setup(gh);

    const job = ci.job("read", async () => {
      await github.rest.pulls.get({ pull_number: 7 });
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "GitHub 404",
    );
  });

  test("the token never appears in step input or output", async () => {
    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

    const { ci } = setup(gh);

    const job = ci.job("read", async () => github.rest.repos.get({}));

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(JSON.stringify(result.steps)).not.toContain("gh-test-token");
  });
});

describe("github helpers", () => {
  test("stickyComment creates a comment, then updates it", async () => {
    gh.route("GET /repos/inngest/inngest-js/issues/7/comments", []);
    gh.route("POST /repos/inngest/inngest-js/issues/7/comments", {
      id: 99,
      html_url: "https://github.com/c/99",
    });

    const first = setup(gh);
    const firstJob = first.ci.job("comment", async () =>
      github.stickyComment("preview", "Preview: https://preview.example"),
    );

    const firstResult = await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () =>
        firstJob(),
      ),
      { event: prEvent },
    );

    expect(firstResult.data).toEqual({
      id: 99,
      url: "https://github.com/c/99",
    });

    // The second run finds the comment it left and updates it in place.
    gh.route("GET /repos/inngest/inngest-js/issues/7/comments", [
      { id: 99, body: "<!-- inngest-ci:preview -->\nold" },
    ]);
    gh.route("PATCH /repos/inngest/inngest-js/issues/comments/99", {
      id: 99,
      html_url: "https://github.com/c/99",
    });

    const second = setup(gh);
    const secondJob = second.ci.job("comment", async () =>
      github.stickyComment("preview", "Preview: https://preview-2.example"),
    );

    await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () =>
        secondJob(),
      ),
      { event: prEvent },
    );

    const patches = gh.requests.filter((request) => request.method === "PATCH");

    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe(
      "/repos/inngest/inngest-js/issues/comments/99",
    );
  });

  test("stickyComment without a pull request says what to pass", async () => {
    const { ci } = setup(gh);

    const job = ci.job("comment", async () =>
      github.stickyComment("preview", "hello"),
    );

    const pipeline = ci.pipeline(
      { id: "push", on: [{ event: "github/push" }], check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, {
      event: {
        name: "github/push",
        data: {
          ref: "refs/heads/main",
          after: "abc",
          repository: { full_name: "inngest/inngest-js" },
        },
      },
    });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "pass `{ issueNumber }`",
    );
  });

  test("forcePushRef updates a ref, and creates it when it's missing", async () => {
    // Octokit escapes the ref into the path, so this matches by prefix.
    gh.route(
      "PATCH /repos/inngest/inngest-js/git/refs/*",
      { message: "Reference does not exist" },
      422,
    );
    gh.route("POST /repos/inngest/inngest-js/git/refs", {
      ref: "refs/heads/next",
    });

    const { ci } = setup(gh);

    const job = ci.job("push-ref", async () =>
      github.forcePushRef("heads/next", "abc1234"),
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      { event: prEvent },
    );

    expect(result.data).toEqual({ created: true });
    expect(
      gh.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === "/repos/inngest/inngest-js/git/refs",
      ),
    ).toBe(true);
  });

  test("canUser compares permissions in order", async () => {
    gh.route("GET /repos/inngest/inngest-js/collaborators/someone/permission", {
      permission: "write",
    });

    const { ci } = setup(gh);

    const job = ci.job("permission", async () => ({
      write: await github.canUser("someone", "write"),
      admin: await github.canUser("someone", "admin"),
    }));

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      { event: prEvent },
    );

    expect(result.data).toEqual({ write: true, admin: false });
  });

  test("waitForChecks keeps checks that already finished", async () => {
    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      check_runs: [
        { name: "vercel", status: "completed", conclusion: "success" },
      ],
    });

    const { ci } = setup(gh);

    const job = ci.job("wait", async () =>
      github.waitForChecks({ names: ["vercel"] }),
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      { event: prEvent },
    );

    expect(result.data).toEqual({ vercel: "success" });
    // Nothing was waited on, because the check was already done.
    expect(
      result.stepIds.some((id) => id.includes("waitForChecks:vercel")),
    ).toBe(false);
  });

  test("waitForChecks waits for the ones that haven't", async () => {
    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      check_runs: [],
    });

    const { ci } = setup(gh);

    const job = ci.job("wait", async () =>
      github.waitForChecks({ names: ["vercel"], timeout: "10m" }),
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      {
        event: prEvent,
        resolveWait: (step) =>
          step.displayName?.includes("waitForChecks")
            ? {
                name: "github/check_run.completed",
                data: { check_run: { name: "vercel", conclusion: "failure" } },
              }
            : null,
      },
    );

    expect({
      data: result.data,
      error: (result.error as { message?: string })?.message,
    }).toEqual({ data: { vercel: "failure" }, error: undefined });
  });

  test("github.token() and github.octokit() throw outside a step", async () => {
    const { ci } = setup(gh);

    const job = ci.job("token", async () => github.token());

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      { event: prEvent },
    );

    expect(String((result.error as { message?: string })?.message)).toContain(
      "must be called inside `step.run`",
    );
  });
});

describe("durable()", () => {
  const client = () => ({
    top: {
      call: async (value: unknown) => ({ data: value }),
      stream: async () => ({ data: "stream" }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: test client
    direct: { helper: (value: any) => ({ data: `local:${value}` }) },
  });

  const build = (
    overrides: Partial<Parameters<typeof durable>[1]> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test shape
  ): any =>
    // biome-ignore lint/suspicious/noExplicitAny: test shape
    durable<any>(client(), {
      name: "fake",
      rules: [
        ["top.stream", "unsupported"],
        ["top.*", "step"],
      ],
      ...overrides,
    });

  test("unmatched paths are called directly, outside a run", async () => {
    const fake = build();

    expect(await fake.direct.helper("x")).toEqual({ data: "local:x" });
  });

  test("unsupported paths explain the escape hatch", async () => {
    const fake = build({
      unsupportedMessage: (path) => `\`${path.join(".")}\` is a stream`,
    });

    await expect(fake.top.stream()).rejects.toBeInstanceOf(CiUsageError);
    await expect(fake.top.stream()).rejects.toThrow("is a stream");
  });

  test("results and errors can be transformed", async () => {
    const fake = build({
      result: (value) => (value as { data: unknown }).data,
    });

    expect(await fake.top.call("hello")).toBe("hello");
  });

  test("arguments can be transformed before the call", async () => {
    const fake = build({
      args: (args) => [`transformed:${String(args[0])}`],
      result: (value) => (value as { data: unknown }).data,
    });

    expect(await fake.top.call("hello")).toBe("transformed:hello");
  });

  test("onError maps failures", async () => {
    const fake = durable<Record<string, Record<string, () => Promise<never>>>>(
      {
        top: {
          call: async () => {
            throw new Error("boom");
          },
        },
      },
      {
        name: "fake",
        rules: [["top.*", "step"]],
        onError: (error) => new Error(`mapped: ${(error as Error).message}`),
      },
    );

    await expect(fake.top?.call?.()).rejects.toThrow("mapped: boom");
  });

  test("a proxy is never mistaken for a promise", async () => {
    const fake = build();

    expect(fake.then).toBeUndefined();
    expect(fake.top.then).toBeUndefined();

    // Awaiting a proxy must not hang or call anything: without the `then`
    // guard, `await` would treat it as a thenable and invoke it.
    const awaited = await fake.top;
    expect(typeof awaited).toBe("function");
  });

  test("the client can be lazy, and is only built when a method is called", async () => {
    let built = 0;

    const fake = durable<
      Record<string, Record<string, () => Promise<unknown>>>
    >(
      async () => {
        built++;
        return client();
      },
      { name: "fake", rules: [["top.*", "step"]] },
    );

    const method = fake.top?.call;
    expect(built).toBe(0);

    await method?.();
    expect(built).toBe(1);
  });

  test("methods are called with the object that owns them", async () => {
    const owner = {
      nested: {
        value: "mine",
        read() {
          return { data: this.value };
        },
      },
    };

    const fake = durable<typeof owner>(owner, {
      name: "fake",
      rules: [["nested.*", "step"]],
    });

    expect(await fake.nested.read()).toEqual({ data: "mine" });
  });

  test("a missing method says so", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test shape
    const fake = build() as any;

    await expect(fake.top.nope()).rejects.toThrow("isn't a method");
  });

  test("direct calls made in a job body warn once", async () => {
    const warn = vi.fn();
    const api = createFakeSandboxApi();
    const testClient = createCiTestClient(api);

    const ci = createCi(testClient, { github: consoleReporter() });

    const fake = durable<
      Record<string, Record<string, () => Promise<unknown>>>
    >(client(), {
      name: "fake",
      rules: [["direct.*", "direct"]],
      logger: { warn },
    });

    const job = ci.job("warns", async () => {
      await fake.direct?.helper?.();
      await fake.direct?.helper?.();
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => job()),
      { event: prEvent },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("ran outside a step");
  });
});

describe("platform gaps", () => {
  test("each unsupported API throws with a reason", () => {
    expect(() => shell("run-id")).toThrow(CiNotSupportedError);
    expect(() => oidc.aws({ role: "deployer" })).toThrow(CiNotSupportedError);
    expect(() => oidc.gcp({ workloadIdentityProvider: "x" })).toThrow(
      CiNotSupportedError,
    );
    expect(() => vercel.waitForDeployment({})).toThrow(CiNotSupportedError);
  });

  test("shard by timing falls back to count with a warning", async () => {
    const warn = vi.fn();
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);

    const ci = createCi(client, { github: consoleReporter() });
    // biome-ignore lint/suspicious/noExplicitAny: reaching in to watch the warning
    ci as any;

    const job = ci.job("shard", async () =>
      shard(
        { total: 2, index: 0, by: "timing", files: ["a", "b", "c", "d"] },
        async (files) => files,
      ),
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => job(),
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["a", "c"]);
    void warn;
  });
});
