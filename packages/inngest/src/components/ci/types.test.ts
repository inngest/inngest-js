/**
 * Type tests for `inngest/ci`.
 *
 * These run under `vitest --typecheck` and in `pnpm test:types`. Nothing here
 * executes: the pipelines and jobs are defined so the checker can look at
 * them, not so they can run. That's why the handlers only ever contain
 * assertions.
 *
 * What's being pinned down is the developer experience: what you get without
 * writing a single type argument, and what the checker stops you doing.
 */

import type { PushEvent } from "@octokit/webhooks-types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expectTypeOf, test } from "vitest";

import { fileCacheStore, memoryCacheStore } from "./cache.ts";
import { $ } from "./command.ts";
import { createCi } from "./createCi.ts";
import type {
  CiNotSupportedError,
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "./errors.ts";
import { sandbox } from "./extraMachine.ts";
import type {
  ConsoleProvider,
  GitHubAppProvider,
  GitHubProvider,
  GitHubTokenProvider,
} from "./github/auth.ts";
import { consoleReporter, githubApp, githubToken } from "./github/auth.ts";
import type { GitHubEventData } from "./github/events.ts";
import { fixtures } from "./github/fixtures.ts";
import type { RunRepo } from "./github/helpers.ts";
import { github } from "./github/index.ts";
import {
  changed,
  checkout,
  files,
  waitForHttp,
  waitForPort,
} from "./helpers.ts";
import { from } from "./machine.ts";
import { report } from "./report.ts";
import { createCiTestClient, createFakeSandboxApi } from "./testHelpers.ts";
import type {
  BackgroundProcess,
  CacheEntry,
  CacheKeyPart,
  CacheStore,
  CheckConclusion,
  CiEvent,
  CiSkip,
  CiTrigger,
  Command,
  CommandResult,
  CommandTag,
  ExtraMachine,
  Job,
  Matrix,
  RepoContext,
} from "./types.ts";

const ci = createCi(createCiTestClient(createFakeSandboxApi()));

/** Defines a pipeline for the checker without running it. */
const definePipeline = ci.pipeline;

/**
 * Type-check a body without running it.
 *
 * Most of what's asserted here needs a pipeline run to execute — `$`, a job,
 * `github.rest` — so the body is handed to the checker and never called.
 */
const types = (_body: () => Promise<unknown> | unknown): void => undefined;

describe("pipeline triggers type the event", () => {
  test("a pull request pipeline knows its payload", () => {
    definePipeline({ id: "pr", on: github.pullRequest() }, async (ctx) => {
      expectTypeOf(ctx.event.data.pull_request.head.sha).toBeString();
      expectTypeOf(ctx.event.data.pull_request.number).toBeNumber();
      expectTypeOf(ctx.event.data.repository.full_name).toBeString();

      // Only the actions this trigger subscribes to.
      expectTypeOf(ctx.event.data.action).toEqualTypeOf<
        "opened" | "synchronize" | "reopened"
      >();

      // The transform's additions are there too.
      expectTypeOf(ctx.event.data._github.event).toBeString();
      expectTypeOf(ctx.event.data._github.installationId).toEqualTypeOf<
        number | undefined
      >();
      expectTypeOf(ctx.event.data.local).toEqualTypeOf<
        { path: string; baseRef: string } | undefined
      >();
    });
  });

  test("`types` narrows the event to those actions", () => {
    definePipeline(
      { id: "closed", on: github.pullRequest({ types: ["closed"] }) },
      async (ctx) => {
        expectTypeOf(ctx.event.data.action).toEqualTypeOf<"closed">();
        // `merged` is only on a closed pull request event.
        expectTypeOf(ctx.event.data.pull_request.merged).toBeBoolean();
      },
    );
  });

  test("a push pipeline knows its payload", () => {
    definePipeline({ id: "push", on: github.push() }, async (ctx) => {
      expectTypeOf(ctx.event.data.after).toBeString();
      expectTypeOf(ctx.event.data.ref).toBeString();
      expectTypeOf(ctx.event.data.deleted).toBeBoolean();
    });
  });

  test("a comment pipeline knows its payload", () => {
    definePipeline(
      { id: "cmd", on: github.comment({ command: "/prerelease" }) },
      async (ctx) => {
        expectTypeOf(ctx.event.data.comment.body).toBeString();
        expectTypeOf(ctx.event.data.issue.number).toBeNumber();
      },
    );
  });

  test("merge group and check suite pipelines know theirs", () => {
    definePipeline({ id: "mq", on: github.mergeGroup() }, async (ctx) => {
      expectTypeOf(ctx.event.data.merge_group.head_sha).toBeString();
    });

    definePipeline(
      { id: "suite", on: github.checkSuite({ branch: "main" }) },
      async (ctx) => {
        expectTypeOf(ctx.event.data.check_suite.conclusion).toBeNullable();
      },
    );
  });

  test("a cron pipeline gets an open record, not `never`", () => {
    definePipeline(
      { id: "nightly", on: { cron: "0 3 * * *" } },
      async (ctx) => {
        expectTypeOf(ctx.event.data).toEqualTypeOf<Record<string, unknown>>();
      },
    );
  });

  test("several triggers give a union, narrowable in the handler", () => {
    definePipeline(
      { id: "both", on: [github.pullRequest(), github.push()] },
      async (ctx) => {
        if ("pull_request" in ctx.event.data) {
          expectTypeOf(ctx.event.data.pull_request.head.sha).toBeString();
        } else {
          expectTypeOf(ctx.event.data.after).toBeString();
        }
      },
    );
  });

  test("a manual trigger's schema types the payload", () => {
    const schema: StandardSchemaV1<{ environment: "preview" | "production" }> =
      {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) => ({
            value: value as { environment: "preview" | "production" },
          }),
        },
      };

    definePipeline(
      { id: "deploy", on: ci.manual({ schema, pipelineId: "deploy" }) },
      async (ctx) => {
        expectTypeOf(ctx.event.data.environment).toEqualTypeOf<
          "preview" | "production"
        >();
      },
    );
  });

  test("the rest of the context is typed", () => {
    definePipeline({ id: "ctx", on: github.push() }, async (ctx) => {
      expectTypeOf(ctx.runId).toBeString();
      expectTypeOf(ctx.pipelineId).toBeString();
      expectTypeOf(ctx.attempt).toBeNumber();
      expectTypeOf(ctx.repo).toEqualTypeOf<RepoContext | undefined>();
      expectTypeOf(ctx.events).toEqualTypeOf<
        CiEvent<GitHubEventData<PushEvent>>[]
      >();
      expectTypeOf(ctx.logger.info).toBeFunction();
    });
  });

  test("a handler may return anything, including `ci.skip`", () => {
    expectTypeOf(ci.skip).returns.toEqualTypeOf<CiSkip>();

    definePipeline({ id: "skips", on: github.push() }, async () =>
      ci.skip("nothing to do"),
    );
  });

  test("triggers are values you can pass around", () => {
    const prTriggers = github.pullRequest({ branches: ["main"] });

    expectTypeOf(prTriggers).toBeArray();
    expectTypeOf(prTriggers).toExtend<CiTrigger[]>();
    // They're ordinary function triggers underneath.
    expectTypeOf<(typeof prTriggers)[number]>().toExtend<{
      event?: unknown;
      if?: string;
    }>();

    definePipeline({ id: "passed", on: prTriggers }, async (ctx) => {
      expectTypeOf(ctx.event.data.pull_request.head.ref).toBeString();
    });
  });
});

describe("jobs infer their input and result", () => {
  test("no input", () => {
    const job = ci.job("plain", async () => 42);

    expectTypeOf(job).toExtend<Job<number>>();
    expectTypeOf(job).returns.resolves.toBeNumber();
    expectTypeOf(job.id).toBeString();
    expectTypeOf(job.kind).toEqualTypeOf<"inngest/ci.job">();
  });

  test("an input, inferred from the handler", () => {
    const job = ci.job("with-input", async (node: string) => node.length);

    expectTypeOf(job).parameter(0).toBeString();
    expectTypeOf(job).returns.resolves.toBeNumber();
  });

  test("an object input", () => {
    const job = ci.job(
      "combo",
      async (input: { node: string; db: "sqlite" | "postgres" }) => input.db,
    );

    expectTypeOf(job).parameter(0).toEqualTypeOf<{
      node: string;
      db: "sqlite" | "postgres";
    }>();
    expectTypeOf(job).returns.resolves.toEqualTypeOf<"sqlite" | "postgres">();
  });

  test("config objects work the same way", () => {
    const job = ci.job(
      { id: "cached", cache: { key: files("pnpm-lock.yaml") } },
      async () => ({ built: true }),
    );

    expectTypeOf(job).returns.resolves.toEqualTypeOf<{ built: boolean }>();
  });

  test("a job that returns nothing is a `Job<void>`", () => {
    const job = ci.job("side-effects", async () => {
      await $`pnpm build`;
    });

    expectTypeOf(job).returns.resolves.toBeVoid();
  });

  test("the checker rejects the wrong input", () => {
    const job = ci.job("needs-string", async (node: string) => node);

    types(async () => {
      // @ts-expect-error a number isn't a string
      await job(22);
      // @ts-expect-error the input isn't optional
      await job();
    });
  });

  test("a job with no input takes no argument", () => {
    const job = ci.job("plain", async () => 1);

    types(async () => {
      await job();
      // @ts-expect-error there's no input to give it
      await job("nope");
    });
  });
});

describe("from() carries the parent's result", () => {
  const setup = ci.job("setup", async () => ({ installed: true }));
  const withInput = ci.job("with-input", async (node: string) => node.length);

  test("the result type comes back", () => {
    types(async () => {
      expectTypeOf(await from(setup)).toEqualTypeOf<{ installed: boolean }>();
    });
  });

  test("an input is passed through, and checked", () => {
    types(async () => {
      expectTypeOf(await from(withInput, "22")).toBeNumber();

      // @ts-expect-error the job needs a string
      await from(withInput, 22);
    });
  });
});

describe("matrices keep their literal values", () => {
  test("combinations are exact", () => {
    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"], db: ["sqlite", "postgres"] },
      },
      async (combo) => {
        expectTypeOf(combo.node).toEqualTypeOf<"20" | "22">();
        expectTypeOf(combo.db).toEqualTypeOf<"sqlite" | "postgres">();
        return combo.node;
      },
    );
  });

  test("the matrix itself is typed", () => {
    const matrix = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => node.length,
    );

    expectTypeOf(matrix).toExtend<
      Matrix<{ node: readonly ["20", "22"] }, number>
    >();
    expectTypeOf(matrix).returns.resolves.toEqualTypeOf<number[]>();
    expectTypeOf(matrix.id).toBeString();
  });

  test("running part of a matrix is checked", () => {
    const matrix = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => node,
    );

    types(async () => {
      expectTypeOf(await matrix()).toEqualTypeOf<("20" | "22")[]>();
      await matrix({ node: "22" });

      // @ts-expect-error "21" isn't one of the values
      await matrix({ node: "21" });
      // @ts-expect-error there's no `db` axis
      await matrix({ db: "sqlite" });
    });
  });

  test("exclude and include are checked against the axes", () => {
    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"], db: ["sqlite", "postgres"] },
        exclude: [{ node: "20", db: "postgres" }],
        include: [{ node: "22", db: "sqlite" }],
      },
      async (combo) => combo.node,
    );

    ci.matrix(
      {
        id: "typo",
        axes: { node: ["20", "22"] },
        // @ts-expect-error "21" was never an axis value
        exclude: [{ node: "21" }],
      },
      async (combo) => combo.node,
    );
  });

  test("per-combination machine and cache see the combination", () => {
    ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"] },
        machine: (combo) => {
          expectTypeOf(combo.node).toEqualTypeOf<"20" | "22">();
          return { vcpu: combo.node === "22" ? 4 : 2 };
        },
        cache: (combo) => ({ key: [files("pnpm-lock.yaml"), combo.node] }),
      },
      async ({ node }) => node,
    );
  });
});

describe("commands", () => {
  test("awaiting one gives a result", () => {
    types(async () => {
      const command = $`pnpm test`;

      expectTypeOf(command).toExtend<Command>();
      expectTypeOf(await command).toEqualTypeOf<CommandResult>();
      expectTypeOf((await command).exitCode).toBeNumber();
      expectTypeOf((await command).truncated).toBeBoolean();
    });
  });

  test("the modifiers chain", () => {
    types(() => {
      expectTypeOf(
        $`pnpm test`
          .env({ CI: "true" })
          .cwd("/work")
          .as("tests")
          .retries(2)
          .nothrow()
          .timeout("10m")
          .onTimeout(async () => undefined),
      ).toExtend<Command>();
    });
  });

  test("output readers are typed", () => {
    types(async () => {
      expectTypeOf(await $`git rev-parse HEAD`.text()).toBeString();
      expectTypeOf(await $`ls`.lines()).toEqualTypeOf<string[]>();
      expectTypeOf(
        await $`cat package.json`.json<{ name: string }>(),
      ).toEqualTypeOf<{ name: string }>();
      expectTypeOf(await $`cat package.json`.json()).toBeUnknown();
    });
  });

  test("backgrounding gives a process handle", () => {
    types(async () => {
      const process = await $`pnpm start`.background();

      expectTypeOf(process).toEqualTypeOf<BackgroundProcess>();
      expectTypeOf(process.id).toBeString();
      expectTypeOf(await process.exited()).toEqualTypeOf<CommandResult>();
      expectTypeOf(await process.output({ tailBytes: 1024 })).toBeString();
      expectTypeOf(await process.kill(9)).toBeVoid();
    });
  });

  test("interpolation accepts what a shell argument can be", () => {
    types(() => {
      const flag: false | string[] = false;

      $`pnpm --filter ${"web"} test`;
      $`pnpm test --bail ${1}`;
      $`pnpm test ${["--reporter", "json"]}`;
      $`pnpm test ${flag}`;
      $`pnpm test ${undefined}`;
      $`pnpm test ${null}`;

      // @ts-expect-error an object has no sensible argument form
      $`pnpm test ${{ reporter: "json" }}`;
    });
  });

  test("`$.sh` is a tag of its own", () => {
    types(() => {
      expectTypeOf($.sh).toEqualTypeOf<CommandTag>();
      expectTypeOf($.sh`a && b`).toExtend<Command>();
      expectTypeOf($.sh`echo ${"quote me"}`).toExtend<Command>();
    });
  });
});

describe("helpers", () => {
  test("checkout, changed, and the waits", () => {
    types(async () => {
      expectTypeOf(await checkout()).toBeVoid();
      expectTypeOf(await checkout({ ref: "abc", submodules: true })).toBeVoid();
      expectTypeOf(await changed("src/**")).toBeBoolean();
      expectTypeOf(
        await changed({ include: ["src/**"], ignore: ["**/*.md"] }),
      ).toBeBoolean();
      expectTypeOf(await waitForHttp("http://127.0.0.1:3000")).toBeVoid();
      expectTypeOf(await waitForPort(3000, { timeout: "30s" })).toBeVoid();

      // @ts-expect-error a port is a number
      await waitForPort("3000");
    });
  });

  test("files() is a cache key part, and keys compose", () => {
    expectTypeOf(files("pnpm-lock.yaml")).toEqualTypeOf<CacheKeyPart>();

    ci.job({ id: "a", cache: { key: files("a") } }, async () => 1);
    ci.job({ id: "b", cache: { key: "v1" } }, async () => 1);
    ci.job({ id: "c", cache: { key: [files("a"), "go1.25"] } }, async () => 1);
    ci.job({ id: "d", cache: { key: async () => "computed" } }, async () => 1);

    // @ts-expect-error a number isn't a key part
    ci.job({ id: "e", cache: { key: 42 } }, async () => 1);
  });

  test("an extra machine has its own command tag", () => {
    types(async () => {
      const extra = await sandbox("api");

      expectTypeOf(extra).toEqualTypeOf<ExtraMachine>();
      expectTypeOf(extra.name).toBeString();
      expectTypeOf(extra.$`pnpm start`).toExtend<Command>();
      expectTypeOf(extra.$.sh`a && b`).toExtend<Command>();
      expectTypeOf(await extra.waitForPort(3000)).toBeVoid();
      expectTypeOf(
        await extra.waitForHttp("http://127.0.0.1:3000", { status: 204 }),
      ).toBeVoid();
    });
  });

  test("report takes markdown and annotations", () => {
    types(async () => {
      expectTypeOf(await report.summary("**hi**")).toBeVoid();
      expectTypeOf(
        await report.annotate([
          { path: "src/a.ts", line: 4, message: "flaky" },
          {
            path: "src/b.ts",
            start_line: 1,
            end_line: 2,
            annotation_level: "warning",
            message: "slow",
            title: "perf",
          },
        ]),
      ).toBeVoid();

      // @ts-expect-error an annotation needs a path and a message
      await report.annotate([{ line: 4 }]);

      await report.annotate([
        // @ts-expect-error "info" isn't one of GitHub's levels
        { path: "a.ts", message: "x", annotation_level: "info" },
      ]);
    });
  });
});

describe("github.rest", () => {
  test("methods return data, not the response", () => {
    types(async () => {
      const release = await github.rest.repos.createRelease({
        tag_name: "v1.4.0",
      });

      expectTypeOf(release.html_url).toBeString();
      expectTypeOf(release.id).toBeNumber();

      const repository = await github.rest.repos.get({});
      expectTypeOf(repository.default_branch).toBeString();
    });
  });

  test("owner and repo are optional, and still accepted", () => {
    types(() => {
      github.rest.pulls.get({ pull_number: 7 });
      github.rest.pulls.get({
        owner: "inngest",
        repo: "inngest-js",
        pull_number: 7,
      });

      // @ts-expect-error `pull_number` is a number
      github.rest.pulls.get({ pull_number: "7" });
    });
  });

  test("unknown namespaces and methods are rejected", () => {
    types(() => {
      // @ts-expect-error there's no such namespace
      github.rest.nope;
      // @ts-expect-error there's no such method
      github.rest.repos.nope;
    });
  });

  test("`.with()` returns the same surface", () => {
    types(async () => {
      const scoped = github.rest.with({ id: "tag-release" });

      expectTypeOf(scoped.git.createRef).toEqualTypeOf<
        typeof github.rest.git.createRef
      >();
      expectTypeOf(
        (await scoped.git.createRef({ ref: "refs/tags/v1", sha: "abc" })).ref,
      ).toBeString();
    });
  });
});

describe("github helpers", () => {
  test("repo() is Octokit-shaped", () => {
    types(() => {
      const repo = github.repo();

      expectTypeOf(repo).toEqualTypeOf<RunRepo>();
      expectTypeOf(repo.owner).toBeString();
      expectTypeOf(repo.number).toEqualTypeOf<number | undefined>();
    });
  });

  test("paginate infers its item type from the method", () => {
    types(async () => {
      const comments = await github.paginate(github.rest.issues.listComments, {
        issue_number: 7,
      });

      expectTypeOf(comments).toBeArray();
      expectTypeOf(comments[0]?.id).toEqualTypeOf<number | undefined>();
      expectTypeOf(comments[0]?.body).toEqualTypeOf<string | undefined>();

      // @ts-expect-error `repos.get` returns one repository, not a list
      await github.paginate(github.rest.repos.get);
    });
  });

  test("the rest of the helpers are typed", () => {
    types(async () => {
      expectTypeOf(
        await github.stickyComment("preview", "https://preview"),
      ).toEqualTypeOf<{ id: number; url: string }>();

      expectTypeOf(
        await github.upsertPullRequest({
          head: "release/next",
          title: "Release",
          body: "…",
        }),
      ).toEqualTypeOf<{ number: number; url: string; created: boolean }>();

      expectTypeOf(
        await github.forcePushRef("heads/next", "abc"),
      ).toEqualTypeOf<{ created: boolean }>();

      expectTypeOf(await github.canUser("someone", "write")).toBeBoolean();

      // @ts-expect-error "owner" isn't a permission level
      await github.canUser("someone", "owner");

      expectTypeOf(
        await github.waitForChecks({ names: ["vercel"], timeout: "10m" }),
      ).toEqualTypeOf<Record<string, CheckConclusion | "timed_out">>();

      expectTypeOf(
        await github.waitForWorkflow({ workflow: "test.yml" }),
      ).toEqualTypeOf<CheckConclusion | "timed_out">();

      expectTypeOf(
        await github.graphql<{ viewer: { login: string } }>("query { … }"),
      ).toEqualTypeOf<{ viewer: { login: string } }>();

      expectTypeOf(await github.token()).toBeString();
    });
  });

  test("fixtures build sendable events", () => {
    types(async () => {
      const event = await fixtures.pullRequest({ action: "synchronize" });

      expectTypeOf(event.name).toBeString();
      expectTypeOf(event.data).toEqualTypeOf<Record<string, unknown>>();

      expectTypeOf(
        await fixtures.push({ ref: "refs/heads/main" }),
      ).toEqualTypeOf<typeof event>();
      expectTypeOf(
        await fixtures.comment({ body: "/prerelease" }),
      ).toEqualTypeOf<typeof event>();

      // @ts-expect-error "merged" isn't a pull request action
      await fixtures.pullRequest({ action: "merged" });
      // @ts-expect-error a comment fixture needs a body
      await fixtures.comment({});
    });
  });
});

describe("providers and stores", () => {
  test("providers share one shape", () => {
    expectTypeOf(githubApp({})).toExtend<GitHubAppProvider>();
    expectTypeOf(githubToken({})).toExtend<GitHubTokenProvider>();
    expectTypeOf(consoleReporter()).toExtend<ConsoleProvider>();
    expectTypeOf(consoleReporter()).toExtend<GitHubProvider>();

    expectTypeOf(githubApp({}).kind).toEqualTypeOf<"app">();
    expectTypeOf(consoleReporter().history).toBeArray();
  });

  test("cache stores are interchangeable", () => {
    expectTypeOf(memoryCacheStore()).toEqualTypeOf<CacheStore>();
    expectTypeOf(fileCacheStore(".cache")).toEqualTypeOf<CacheStore>();

    const custom: CacheStore = {
      get: async () => undefined,
      set: async () => undefined,
    };

    expectTypeOf(custom.get).returns.resolves.toEqualTypeOf<
      CacheEntry | undefined
    >();

    createCi(createCiTestClient(createFakeSandboxApi()), {
      github: consoleReporter(),
      cacheStore: custom,
      machine: { vcpu: 4 },
      runUrl: ({ runId, functionId }) => `${functionId}/${runId}`,
    });

    createCi(createCiTestClient(createFakeSandboxApi()), {
      // @ts-expect-error 3 vCPUs isn't one of the sizes
      machine: { vcpu: 3 },
    });
  });
});

describe("errors", () => {
  test("each carries what you need to report it", () => {
    expectTypeOf<CiUsageError>().toExtend<Error>();
    expectTypeOf<CiNotSupportedError["feature"]>().toBeString();
    expectTypeOf<CommandFailedError["command"]>().toEqualTypeOf<string[]>();
    expectTypeOf<CommandFailedError["exitCode"]>().toBeNumber();
    expectTypeOf<CommandFailedError["stderrTail"]>().toBeString();
    expectTypeOf<CommandFailedError["jobPath"]>().toBeString();
    expectTypeOf<CommandTimeoutError["timeout"]>().toBeString();
  });
});

describe("the entry point exports what the docs use", () => {
  test("`inngest/ci` is importable as a whole", async () => {
    const entry = await import("../../ci.ts");

    expectTypeOf(entry.createCi).toBeFunction();
    expectTypeOf(entry.$).toBeFunction();
    expectTypeOf(entry.github).toBeObject();
    expectTypeOf(entry.from).toBeFunction();
    expectTypeOf(entry.checkout).toBeFunction();
    expectTypeOf(entry.changed).toBeFunction();
    expectTypeOf(entry.files).toBeFunction();
    expectTypeOf(entry.sandbox).toBeFunction();
    expectTypeOf(entry.report).toBeObject();
    expectTypeOf(entry.fixtures).toBeObject();
    expectTypeOf(entry.githubWebhookTransform).toBeString();
    expectTypeOf(entry.memoryCacheStore).toBeFunction();
    expectTypeOf(entry.fileCacheStore).toBeFunction();
    expectTypeOf(entry.consoleReporter).toBeFunction();
  });
});
