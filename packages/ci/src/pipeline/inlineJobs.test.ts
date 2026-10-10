/**
 * Tests of jobs defined inside a pipeline: they exist only in the run that
 * defined them, so they build in that run instead of through the build
 * function, and a job that starts from one does too.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { machineSetupScript } from "../machine/machine.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { getRunScope } from "./scope.ts";

type Api = ReturnType<typeof createFakeSandboxApi>;

const setup = (api: Api = createFakeSandboxApi()) => {
  const client = createCiTestClient(api);

  const ci = createCi(client, {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { api, ci };
};

const count = (api: Api, command: string): number => {
  return api.commands
    .filter((argv) => {
      return argv[2] !== machineSetupScript;
    })
    .filter((argv) => {
      return argv.join(" ") === command;
    }).length;
};

/** The steps that invoke the build function. */
const invokes = (stepIds: string[]) => {
  return stepIds.filter((stepId) => {
    return stepId.endsWith("› build");
  });
};

const machineOf = (api: Api, jobId: string, runId = "01TESTRUN") => {
  return [...api.sandboxes.values()].find((machine) => {
    return machine.name === `ci-${runId}-${jobId}`;
  });
};

const snapshotNamed = (api: Api, name: RegExp) => {
  return [...api.snapshots.values()].find((snapshot) => {
    return snapshot.name && name.test(snapshot.name);
  });
};

describe("inline jobs", () => {
  test("an inline parent builds in the run and its child starts from the run's snapshot", async () => {
    const { api, ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const base = ci.job("base", async () => {
        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
        await $`pnpm lint`;
      });

      await lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokes(result.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm lint")).toBe(1);

    // The run's snapshot is gone once the run's cleanup has deleted it.
    expect(machineOf(api, "lint")?.snapshotId).toBeTruthy();
    expect(api.snapshots.size).toBe(0);

    const spanNames = Object.values(result.spans)
      .flat()
      .map((span) => {
        return span.name;
      });

    expect(spanNames).toContain("Build base inline");
  });

  test("an inline cached job is found by its name in a later run", async () => {
    const { api, ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
        await $`pnpm lint`;
      });

      await lint();

      return getRunScope()?.warnings;
    });

    const cold = await runFunction(pipeline, {
      event: prEvent,
      runId: "01COLD",
    });

    expect(cold.type).toBe("function-resolved");
    expect(invokes(cold.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);

    const cached = snapshotNamed(api, /^ci\/pr:7\/base\//);

    expect(cached?.status).toBe("READY");
    expect(machineOf(api, "lint", "01COLD")?.snapshotId).toBe(cached?.id);

    expect(cold.data).toEqual([
      "built in this run: `base` is defined inside the pipeline, so concurrent runs aren't deduplicated",
    ]);

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warm.type).toBe("function-resolved");
    expect(invokes(warm.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(warm.data).toEqual([]);
    expect(machineOf(api, "lint", "01WARM")?.snapshotId).toBe(cached?.id);
  });

  test("an inline cached job called directly builds in the run and is reused by the next", async () => {
    const { api, ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const install = ci.job(
        { id: "install", cache: { key: "v1" } },
        async () => {
          await $`pnpm install`;
        },
      );

      await install();

      return getRunScope()?.warnings.length;
    });

    const cold = await runFunction(pipeline, {
      event: prEvent,
      runId: "01COLD",
    });

    expect(invokes(cold.stepIds)).toEqual([]);
    expect(cold.data).toBe(1);

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(invokes(warm.stepIds)).toEqual([]);
    expect(warm.data).toBe(0);
    expect(count(api, "pnpm install")).toBe(1);
  });

  test("a top-level cached job still goes through the build function", async () => {
    const { ci } = setup();

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await install();

      return getRunScope()?.warnings;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokes(result.stepIds)).toEqual(["install › build"]);
    expect(result.data).toEqual([]);
  });

  test("a top-level job whose parent is inline builds in the run too", async () => {
    const { api, ci } = setup();

    const parents: { current?: ReturnType<typeof ci.job> } = {};

    const lint = ci.job(
      {
        id: "lint",
        cache: { key: "v1" },
        from: () => {
          return parents.current as never;
        },
      },
      async () => {
        await $`pnpm lint`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      parents.current = ci.job("base", async () => {
        await $`pnpm install`;
      });

      await lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokes(result.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm lint")).toBe(1);
  });

  test("a parent's `from` is read from its validated input, so a parent whose parent is inline builds in the run", async () => {
    const { api, ci } = setup();

    const parents: { current?: ReturnType<typeof ci.job> } = {};

    // Gives { pick } from a string, and rejects anything else, as a schema
    // that changes the shape of its input does.
    const input = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: (value: unknown) => {
          return typeof value === "string"
            ? { value: { pick: value } }
            : { issues: [{ message: "Expected string" }] };
        },
      },
    };

    const mid = ci.job(
      {
        id: "mid",
        input: input as never,
        from: ({ input }: { input: { pick: string } }) => {
          if (input.pick !== "base") {
            throw new Error("the raw input was read");
          }

          return parents.current as never;
        },
      },
      async () => {
        await $`pnpm mid`;
      },
    );

    const leaf = ci.job(
      {
        id: "leaf",
        from: (mid as unknown as { with: (value: string) => never }).with(
          "base",
        ),
      },
      async () => {
        await $`pnpm leaf`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      parents.current = ci.job("base", async () => {
        await $`pnpm install`;
      });

      await leaf();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokes(result.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm mid")).toBe(1);
    expect(count(api, "pnpm leaf")).toBe(1);
  });

  test("defining one ID twice in a run says to put what varies in the id", async () => {
    const { ci } = setup();

    const makeTest = (pkg: string) => {
      return ci.job("test", async () => {
        await $`pnpm --filter ${pkg} test`;
      });
    };

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await makeTest("a")();
      await makeTest("b")();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain(
      "is defined twice in this run",
    );
    expect(JSON.stringify(result.error)).toContain("put what varies");
  });

  test("the same factory in two runs is fine", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      for (const pkg of ["a", "b"]) {
        const job = ci.job(`test ${pkg}`, async () => {
          await $`pnpm --filter ${pkg} test`;
        });

        await job();
      }
    });

    for (const runId of ["01ONE", "01TWO"]) {
      const result = await runFunction(pipeline, { event: prEvent, runId });

      expect(result.type).toBe("function-resolved");
    }
  });
});
