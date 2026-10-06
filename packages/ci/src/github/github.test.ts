/**
 * Tests for the `github` helpers, REST wrapper, triggers and providers.
 *
 * @module
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { shard } from "../checkout/shard.ts";
import { CiUsageError } from "../errors.ts";
import { createCi } from "../pipeline/createCi.ts";
import { durable, resetDurableWarnings } from "../pipeline/durable.ts";
import { rerunEventFor } from "../pipeline/rerun.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeGitHub, type FakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { consoleReporter, githubToken } from "./auth.ts";
import { github } from "./index.ts";

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
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
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
      async () => {
        return job();
      },
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
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    const calls = result.stepIds.filter((id) => {
      return id.startsWith("read › github.repos.get");
    });

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
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.stepIds).toContain("tag › tag-release");
  });

  test("calls inside step.run run directly, as one step", async () => {
    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });
    gh.route("GET /repos/inngest/inngest-js/pulls/7", { mergeable: true });

    const { ci, client } = setup(gh);

    const job = ci.job("read", async () => {
      const { step } = await import("inngest");

      return step.run("read-both", async () => {
        const repo = await github.rest.repos.get({});
        const pull = await github.rest.pulls.get({ pull_number: 7 });

        return { branch: repo.default_branch, mergeable: pull.mergeable };
      });
    });

    void client;

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ branch: "main", mergeable: true });

    // One step for the two calls, not three.
    expect(
      result.stepIds.filter((id) => {
        return id.includes("github.");
      }),
    ).toEqual([]);

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
      async () => {
        return job();
      },
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

    const job = ci.job("read", async () => {
      return github.rest.repos.get({});
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => {
        return job();
      },
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

    const firstJob = first.ci.job("comment", async () => {
      return github.stickyComment(
        "preview",
        "Preview: https://preview.example",
      );
    });

    const firstResult = await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return firstJob();
      }),
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

    const secondJob = second.ci.job("comment", async () => {
      return github.stickyComment(
        "preview",
        "Preview: https://preview-2.example",
      );
    });

    await runFunction(
      second.ci.pipeline(
        { id: "pr", on: prTrigger, check: false },
        async () => {
          return secondJob();
        },
      ),
      { event: prEvent },
    );

    const patches = gh.requests.filter((request) => {
      return request.method === "PATCH";
    });

    expect(patches).toHaveLength(1);

    expect(patches[0]?.path).toBe(
      "/repos/inngest/inngest-js/issues/comments/99",
    );
  });

  test("stickyComment without a pull request says what to pass", async () => {
    const { ci } = setup(gh);

    const job = ci.job("comment", async () => {
      return github.stickyComment("preview", "hello");
    });

    const pipeline = ci.pipeline(
      { id: "push", on: [{ event: "github/push" }], check: false },
      async () => {
        return job();
      },
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

    const job = ci.job("push-ref", async () => {
      return github.forcePushRef("heads/next", "abc1234");
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(result.data).toEqual({ created: true });

    expect(
      gh.requests.some((request) => {
        return (
          request.method === "POST" &&
          request.path === "/repos/inngest/inngest-js/git/refs"
        );
      }),
    ).toBe(true);
  });

  test("canUser compares permissions in order", async () => {
    gh.route("GET /repos/inngest/inngest-js/collaborators/someone/permission", {
      permission: "write",
    });

    const { ci } = setup(gh);

    const job = ci.job("permission", async () => {
      return {
        write: await github.canUser("someone", "write"),
        admin: await github.canUser("someone", "admin"),
      };
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(result.data).toEqual({ write: true, admin: false });
  });

  test("waitForChecks keeps checks that already finished", async () => {
    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      total_count: 1,
      check_runs: [
        { name: "vercel", status: "completed", conclusion: "success" },
      ],
    });

    const { ci } = setup(gh);

    const job = ci.job("wait", async () => {
      return github.waitForChecks({ names: ["vercel"] });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(result.data).toEqual({ vercel: "success" });

    // Nothing was waited on, because the check was already done.
    expect(
      result.stepIds.some((id) => {
        return id.includes("waitForChecks:vercel");
      }),
    ).toBe(false);
  });

  test("waitForChecks waits for the ones that haven't", async () => {
    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      total_count: 0,
      check_runs: [],
    });

    const { ci } = setup(gh);

    const job = ci.job("wait", async () => {
      return github.waitForChecks({ names: ["vercel"], timeout: "10m" });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      {
        event: prEvent,
        resolveWait: (step) => {
          return step.displayName === "Wait for check: vercel"
            ? {
                name: "github/check_run.completed",
                data: { check_run: { name: "vercel", conclusion: "failure" } },
              }
            : null;
        },
      },
    );

    expect({
      data: result.data,
      error: (result.error as { message?: string })?.message,
    }).toEqual({ data: { vercel: "failure" }, error: undefined });
  });

  test("github.token() and github.octokit() throw outside a step", async () => {
    const { ci } = setup(gh);

    const job = ci.job("token", async () => {
      return github.token();
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(String((result.error as { message?: string })?.message)).toContain(
      "must be called inside `step.run`",
    );
  });
});

describe("durable()", () => {
  const client = () => {
    return {
      top: {
        call: async (value: unknown) => {
          return { data: value };
        },
        stream: async () => {
          return { data: "stream" };
        },
      },
      direct: {
        // biome-ignore lint/suspicious/noExplicitAny: test client
        helper: (value: any) => {
          return { data: `local:${value}` };
        },
      },
    };
  };

  const build = (
    overrides: Partial<Parameters<typeof durable>[1]> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test shape
  ): any => {
    // biome-ignore lint/suspicious/noExplicitAny: test shape
    return durable<any>(client(), {
      name: "fake",
      rules: [["top.*", "step"]],
      ...overrides,
    });
  };

  test("unmatched paths are called directly, outside a run", async () => {
    const fake = build();

    expect(await fake.direct.helper("x")).toEqual({ data: "local:x" });
  });

  test("results and errors can be transformed", async () => {
    const fake = build({
      result: (value) => {
        return (value as { data: unknown }).data;
      },
    });

    expect(await fake.top.call("hello")).toBe("hello");
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
        onError: (error) => {
          return new Error(`mapped: ${(error as Error).message}`);
        },
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
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain("ran outside a step");
  });
});

describe("shard", () => {
  test("splits files evenly by count", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);

    const ci = createCi(client, { github: consoleReporter() });

    const job = ci.job("shard", async () => {
      return shard(
        { total: 2, index: 0, files: ["a", "b", "c", "d"] },
        async (files) => {
          return files;
        },
      );
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["a", "c"]);
  });
});

describe("re-running from a check suite", () => {
  test("`check_suite.rerequested` resends the trigger for the suite's commit", async () => {
    setup(gh);

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/pulls", []);

    gh.route("GET /repos/inngest/inngest-js/branches/main", {
      commit: { sha: "abc1234" },
    });

    const send = vi.fn(async () => {
      return undefined;
    });

    const result = await rerunEventFor({
      event: {
        name: "github/check_suite.rerequested",
        data: {
          action: "rerequested",
          check_suite: { id: 9, head_sha: "abc1234", head_branch: "main" },
          repository: {
            full_name: "inngest/inngest-js",
            default_branch: "main",
          },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => {
          return fn();
        },
      },
      client: { send } as never,
      config: { id: "pr" } as never,
    });

    expect(result).toMatchObject({ rerun: true, sha: "abc1234" });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("helper edge cases", () => {
  test("canUser answers false for a 404 but retries a server error", async () => {
    gh.route(
      "GET /repos/inngest/inngest-js/collaborators/ghost/permission",
      { message: "Not Found" },
      404,
    );

    gh.route(
      "GET /repos/inngest/inngest-js/collaborators/flaky/permission",
      { message: "Server Error" },
      500,
    );

    const { ci } = setup(gh);

    const job = ci.job("permission", async () => {
      const ghost = await github.canUser("ghost", "write");

      let flaky: unknown = "unset";

      try {
        flaky = await github.canUser("flaky", "write");
      } catch {
        flaky = "threw";
      }

      return { ghost, flaky };
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(result.data).toEqual({ ghost: false, flaky: "threw" });
  });

  test("waitForChecks reads every page of check runs", async () => {
    const requested: string[] = [];

    const pages = [
      {
        check_runs: [
          { name: "lint", status: "completed", conclusion: "success" },
        ],
        link: '<https://api.github.test/repos/inngest/inngest-js/commits/abc1234/check-runs?per_page=100&page=2>; rel="next"',
      },
      {
        check_runs: [
          { name: "vercel", status: "completed", conclusion: "success" },
        ],
      },
    ];

    gh.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input.toString());

      requested.push(url.search);

      const page = pages[url.searchParams.get("page") === "2" ? 1 : 0];

      const response = new Response(
        JSON.stringify({
          total_count: 2,
          check_runs: page?.check_runs,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...(page?.link ? { Link: page.link } : {}),
          },
        },
      );

      Object.defineProperty(response, "url", { value: url.href });

      return response;
    }) as typeof fetch;

    const { ci } = setup(gh);

    const job = ci.job("wait", async () => {
      return github.waitForChecks({ names: ["vercel"] });
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      { event: prEvent },
    );

    expect(result.data).toEqual({ vercel: "success" });
    expect(requested[0]).toContain("per_page=100");
    expect(requested).toHaveLength(2);
  });

  test("waitForWorkflow only accepts the requested workflow", async () => {
    gh.route("GET /repos/inngest/inngest-js/actions/workflows/*", {
      workflow_runs: [],
    });

    const { ci } = setup(gh);
    const conditions: string[] = [];

    const job = ci.job("wait", async () => {
      const byName = await github.waitForWorkflow({ workflow: "deploy.yml" });
      const byId = await github.waitForWorkflow({ workflow: "1234" });

      return { byName, byId };
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, check: false }, async () => {
        return job();
      }),
      {
        event: prEvent,
        resolveWait: (step) => {
          conditions.push(
            String((step as { opts?: { if?: string } }).opts?.if),
          );

          return null;
        },
      },
    );

    expect(conditions[0]).toContain('path.endsWith("/deploy.yml")');
    expect(conditions[0]).toContain('head_sha == "abc1234"');
  });
});

describe("re-running from a check run", () => {
  const rerun = async (
    event: unknown,
    config: Record<string, unknown> = { id: "pr" },
  ) => {
    setup(gh);

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/pulls", []);

    const send = vi.fn(async () => {
      return undefined;
    });

    const result = await rerunEventFor({
      event,
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => {
          return fn();
        },
      },
      client: { send } as never,
      config: config as never,
    });

    return { result, send };
  };

  const checkRunEvent = (checkRun: Record<string, unknown>) => {
    return {
      id: "evt-1",
      name: "github/check_run.rerequested",
      data: {
        action: "rerequested",
        check_run: {
          id: 5,
          head_sha: "abc1234",
          check_suite: { head_branch: "feature" },
          ...checkRun,
        },
        repository: { full_name: "inngest/inngest-js", default_branch: "main" },
        _github: { delivery: "delivery-1" },
      },
    };
  };

  test("another app's check with an external ID is not ours", async () => {
    const { result, send } = await rerun(
      checkRunEvent({ name: "other-app", external_id: "something" }),
    );

    expect(result).toMatchObject({ rerun: false });
    expect(send).not.toHaveBeenCalled();
  });

  test("the resent event has an ID derived from the delivery", async () => {
    gh.route("GET /repos/inngest/inngest-js/branches/feature", {
      commit: { sha: "abc1234" },
    });

    const { send } = await rerun(
      checkRunEvent({ name: "pr / test", external_id: "RUN:test" }),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ci-rerun-delivery-1" }),
    );
  });

  test("a check on a branch re-pushes that branch, not the default one", async () => {
    gh.route("GET /repos/inngest/inngest-js/branches/feature", {
      commit: { sha: "abc1234" },
    });

    const { send } = await rerun(checkRunEvent({ name: "pr" }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "github/push",
        data: expect.objectContaining({
          ref: "refs/heads/feature",
          after: "abc1234",
        }),
      }),
    );
  });

  test("a check's own pull request is used without listing PRs", async () => {
    const { send } = await rerun(
      checkRunEvent({
        name: "pr",
        pull_requests: [{ number: 12, head: { sha: "abc1234", ref: "f" } }],
      }),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "github/pull_request.synchronize",
        data: expect.objectContaining({ number: 12 }),
      }),
    );
  });

  test("nothing is sent when there is no pull request or branch", async () => {
    const event = checkRunEvent({ name: "pr" });

    event.data.check_run.check_suite = undefined as never;

    const { result, send } = await rerun(event);

    expect(result).toMatchObject({ rerun: false });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("re-running a check from a fork", () => {
  test("with no pull request, nothing is sent", async () => {
    const send = vi.fn(async () => {
      return undefined;
    });

    const result = await rerunEventFor({
      event: {
        id: "evt-1",
        name: "github/check_suite.rerequested",
        data: {
          check_suite: {
            head_sha: "abc1234",
            head_branch: "main",
            head_repository: { full_name: "someone/inngest-js" },
          },
          repository: { full_name: "inngest/inngest-js" },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => {
          return fn();
        },
      },
      client: { send } as never,
      config: { id: "pr" } as never,
    });

    expect(result).toMatchObject({ rerun: false });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("re-running a check whose branch moved or is not ours", () => {
  const rerunSuite = async () => {
    const send = vi.fn(async () => {
      return undefined;
    });

    const result = await rerunEventFor({
      event: {
        id: "evt-1",
        name: "github/check_suite.rerequested",
        data: {
          check_suite: { head_sha: "abc1234", head_branch: "main" },
          repository: { full_name: "inngest/inngest-js" },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => {
          return fn();
        },
      },
      client: { send } as never,
      config: { id: "pr" } as never,
    });

    return { result, send };
  };

  test("a branch head that is a different commit sends nothing", async () => {
    setup(gh);

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/pulls", []);

    gh.route("GET /repos/inngest/inngest-js/branches/main", {
      commit: { sha: "someoneelse" },
    });

    const { result, send } = await rerunSuite();

    expect(result).toMatchObject({ rerun: false });
    expect(send).not.toHaveBeenCalled();
  });

  test("a failed branch lookup sends nothing", async () => {
    setup(gh);

    gh.route(
      "GET /repos/inngest/inngest-js/branches/main",
      { message: "Not Found" },
      404,
    );

    const { result, send } = await rerunSuite();

    expect(result).toMatchObject({ rerun: false });
    expect(send).not.toHaveBeenCalled();
  });
});
