/**
 * The README example, run end to end against the fake sandbox API.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step } from "inngest";
import { describe, expect, test } from "vitest";
import { files } from "./cache/cache.ts";
import { changed } from "./checkout/changed.ts";
import { checkout } from "./checkout/checkout.ts";
import { waitForHttp } from "./checkout/wait.ts";
import { consoleReporter } from "./github/auth.ts";
import { $ } from "./machine/command.ts";
import { createCi } from "./pipeline/createCi.ts";
import { createCiTestClient } from "./testing/client.ts";
import { createFakeSandboxApi } from "./testing/fakeSandbox.ts";
import { runFunction } from "./testing/runFunction.ts";

/**
 * The shape of the example's `pr` pipeline, run end to end: a cached setup
 * job, jobs starting from it, a curried job factory, a job with no machine
 * whose SDK call fails once, and an e2e job with a background server.
 *
 * This is here so the code in `examples/ci-pipelines/ci/` is covered by
 * something that actually runs it.
 */
/**
 * A throwaway git repository whose `feature` branch changes a source file,
 * so `changed()` sees the same thing wherever the tests run. Without
 * `withBase`, there is no `main` to compare against.
 */
const makeRepo = ({ withBase }: { withBase: boolean }): string => {
  const dir = mkdtempSync(join(tmpdir(), "inngest-ci-example-"));

  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };

  git("init", "-q", "-b", withBase ? "main" : "feature");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");

  if (withBase) {
    git("checkout", "-q", "-b", "feature");
  }

  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-q", "-m", "change");

  return dir;
};

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
    // A local fixture, as `pnpm ci:send` builds: `changed()` and `checkout()`
    // use the working tree rather than GitHub.
    local: { path: makeRepo({ withBase: true }), baseRef: "main" },
  },
};

const buildPipeline = () => {
  const api = createFakeSandboxApi();

  api.script([
    { match: "pnpm install", stdout: "installed" },
    { match: "serve", ticks: 1, stdout: "listening" },
    { match: "curl", stdout: "200" },
  ]);

  const client = createCiTestClient(api);
  const reporter = consoleReporter();

  const ci = createCi(client, {
    github: reporter,
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  let deployAttempts = 0;

  // What the jobs saw, since jobs return nothing.
  const seen: { previewUrl?: string; testedAgainst?: string } = {};

  const setup = ci.job(
    { id: "setup", cache: { key: files("pnpm-lock.yaml") } },
    async () => {
      await checkout();

      await $`pnpm install`;
    },
  );

  const lint = ci.job({ id: "lint", from: setup }, async () => {
    await $`pnpm lint`;
  });

  const test = ci.job({ id: "test", from: setup }, async () => {
    await $`pnpm test`.retries(1);
  });

  const compat = (node: string) => {
    return ci.job({ id: `compat (node:${node})`, from: setup }, async () => {
      await $`pnpm test`.env({ NODE_VERSION: node });
    })();
  };

  // No commands, so no machine: the SDK call fails once and is retried.
  const deploy = ci.job("deploy", async () => {
    const created = await step.run("create-deployment", async () => {
      deployAttempts += 1;

      if (deployAttempts === 1) {
        throw new Error("deploy provider returned 503");
      }

      return { url: "https://preview.example.dev" };
    });

    seen.previewUrl = created.url;
  });

  const e2e = (baseUrl: string) => {
    return ci.job({ id: "e2e", from: setup }, async () => {
      await $`serve`.background();

      await waitForHttp("http://127.0.0.1:3000");

      await $`pnpm exec playwright test`.env({ BASE_URL: baseUrl });

      seen.testedAgainst = baseUrl;
    })();
  };

  const pipeline = ci.pipeline(
    {
      id: "pr",
      on: [{ event: "github/pull_request.opened" }],
      singleton: { key: "event.data.pull_request.number", mode: "cancel" },
    },
    async () => {
      if (!(await changed({ ignore: ["docs/**"] }))) {
        return ci.skip("only docs changed");
      }

      await Promise.all([lint(), test(), ...["20", "22"].map(compat)]);

      await deploy();

      await e2e(seen.previewUrl as string);

      return;
    },
  );

  return {
    api,
    ci,
    reporter,
    pipeline,
    seen,
    deploys: () => {
      return deployAttempts;
    },
  };
};

describe("the example's pr pipeline", () => {
  test("runs everything when the base branch can't be found", async () => {
    const { pipeline, seen } = buildPipeline();

    const event = {
      ...prEvent,
      data: {
        ...prEvent.data,
        local: { path: makeRepo({ withBase: false }), baseRef: "main" },
      },
    };

    const result = await runFunction(pipeline, { event, maxRequests: 400 });

    expect(result.type).toBe("function-resolved");
    expect(seen.testedAgainst).toBe("https://preview.example.dev");
  });

  test("runs every job, and reports every check", async () => {
    const { api, reporter, pipeline, seen, deploys } = buildPipeline();

    const result = await runFunction(pipeline, {
      event: prEvent,
      maxRequests: 400,
    });

    expect({
      type: result.type,
      error: (result.error as { message?: string })?.message,
    }).toEqual({ type: "function-resolved", error: undefined });

    // `deploy` returns nothing, so `e2e` is handed its URL by the pipeline.
    expect(seen.testedAgainst).toBe("https://preview.example.dev");
    expect(deploys()).toBe(2);

    // One machine for setup, built in its own run, and one clone each for the
    // jobs that start from it. `deploy` never gets one.
    const machines = [...api.sandboxes.values()];

    expect(
      machines.map((machine) => {
        return machine.name;
      }),
    ).toEqual([
      expect.stringMatching(/^ci-01TESTINVOKED\d+-setup$/),
      "ci-01TESTRUN-lint",
      "ci-01TESTRUN-test",
      "ci-01TESTRUN-compat-node-20",
      "ci-01TESTRUN-compat-node-22",
      "ci-01TESTRUN-e2e",
    ]);

    // Everything but setup is a clone of setup's snapshot.
    expect(
      machines.filter((machine) => {
        return machine.snapshotId;
      }),
    ).toHaveLength(5);

    expect(api.snapshots.size).toBe(1);

    // Setup installed once, however many jobs started from it.
    expect(
      api.commands.filter((argv) => {
        return argv.join(" ") === "pnpm install";
      }),
    ).toHaveLength(1);

    const completed = reporter.history
      .filter((entry) => {
        return entry.status === "completed";
      })
      .map((entry) => {
        return `${entry.name}: ${entry.conclusion}`;
      });

    // `setup` is only started from, so it is built in a run of its own and
    // has no check.
    expect(completed).toEqual([
      "pr / lint: success",
      "pr / test: success",
      "pr / compat (node:20): success",
      "pr / compat (node:22): success",
      "pr / deploy: success",
      "pr / e2e: success",
      "pr: success",
    ]);

    // Every machine is destroyed with the run.
    expect(
      machines.every((machine) => {
        return machine.status === "TERMINATED";
      }),
    ).toBe(true);
  });

  test("a failing test fails its job check and the pipeline check", async () => {
    const { api, reporter, pipeline } = buildPipeline();

    api.script([
      { match: "pnpm install", stdout: "installed" },
      { match: "pnpm test", exitCode: 1, stderr: "1 failing" },
    ]);

    const result = await runFunction(pipeline, {
      event: prEvent,
      maxRequests: 400,
    });

    expect(result.type).toBe("function-rejected");

    const completed = reporter.history.filter((entry) => {
      return entry.status === "completed";
    });

    // `test` and both `compat` jobs run `pnpm test`, and they're started with
    // `Promise.all`, so whichever fails first ends the run.
    const failed = completed.filter((entry) => {
      return entry.conclusion === "failure" && entry.name !== "pr";
    });

    expect(failed.length).toBeGreaterThan(0);

    expect(
      failed.every((entry) => {
        return entry.title === "`pnpm test` exited with 1";
      }),
    ).toBe(true);

    // The jobs that were still going are cancelled rather than left spinning,
    // and every check that started has finished.
    const started = reporter.history.filter((entry) => {
      return entry.status === "in_progress";
    });

    expect(
      new Set(
        completed.map((entry) => {
          return entry.name;
        }),
      ),
    ).toEqual(
      new Set(
        started.map((entry) => {
          return entry.name;
        }),
      ),
    );

    expect(
      completed.filter((entry) => {
        return entry.conclusion === "cancelled";
      }).length,
    ).toBeGreaterThan(0);

    const pipelineCheck = completed.find((entry) => {
      return entry.name === "pr";
    });

    expect(pipelineCheck?.conclusion).toBe("failure");
    expect(pipelineCheck?.title).toContain("exited with 1");
  });
});
