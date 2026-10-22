/**
 * Tests for Live Tap Pull using fixture API data and real functions.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../../test/helpers.ts";
import { prepareConnectionConfig } from "./config.ts";
import { fetchRecordedRun, PullDataError, readPullSettings } from "./pull.ts";
import { replayRun } from "./pullReplay.ts";
import { writeTestScaffold } from "./pullTest.ts";

const event = { id: "evt1", name: "demo/sent", data: { n: 2 } };

const fixtureApi = (outputs: Record<string, unknown>, failed?: string) => {
  const span = (stepId: string, output: unknown) => {
    return {
      name: stepId,
      stepId,
      stepOp: "TRACE_STEP_OP_RUN",
      status: stepId === failed ? "FAILED" : "COMPLETED",
      output,
      children: [],
    };
  };

  const bodies: Record<string, unknown> = {
    "/api/v2/runs/RUN1?include_output=true": {
      data: {
        id: "RUN1",
        function: { id: "app-double" },
        trigger: { eventIds: ["evt1"] },
      },
    },
    "/api/v2/runs/RUN1/trace?include_output=true": {
      data: {
        runId: "RUN1",
        rootSpan: {
          children: Object.entries(outputs).map(([id, output]) => {
            return span(id, output);
          }),
        },
      },
    },
    "/v1/events/evt1": { data: event },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = bodies[new URL(url).pathname + new URL(url).search];

      return body
        ? new Response(JSON.stringify(body))
        : new Response("not found", { status: 404 });
    }),
  );
};

const fetchOpts = {
  runId: "RUN1",
  apiBaseUrl: "http://localhost:8288",
  mode: "dev" as const,
  signingKey: undefined,
  env: undefined,
};

const build = (multiplier: number) => {
  const client = createClient({ id: "app", isDev: true });
  const fn = client.createFunction(
    { id: "double", triggers: [{ event: "demo/sent" }] },
    async ({ event, step }) => {
      const base = await step.run("base", () => {
        return Number(event.data.n);
      });

      return step.run("scaled", () => {
        return base * multiplier;
      });
    },
  );
  const { requestHandlers } = prepareConnectionConfig(
    [{ client, functions: [fn] }],
    client,
  );

  return requestHandlers.app!;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPullSettings", () => {
  it("is off without INNGEST_TAP_PULL", () => {
    expect(readPullSettings({})).toBeUndefined();
  });

  it("reads the run, step and test path", () => {
    expect(
      readPullSettings({
        INNGEST_TAP_PULL: "R",
        INNGEST_TAP_PULL_STEP: "s",
        INNGEST_TAP_PULL_TEST: "a.test.ts",
      }),
    ).toEqual({ runId: "R", step: "s", testPath: "a.test.ts" });
  });
});

describe("Pull", () => {
  it("replays with no differences on unchanged code", async () => {
    fixtureApi({ base: 2, scaled: 4 });
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(2),
      appName: "app",
      functionSlug: "app-double",
    });

    expect(
      diffs.map((d) => {
        return [d.id, d.status];
      }),
    ).toEqual([
      ["base", "same"],
      ["scaled", "same"],
    ]);
  });

  it("reports the step whose result changed", async () => {
    fixtureApi({ base: 2, scaled: 4 });
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(3),
      appName: "app",
      functionSlug: "app-double",
    });

    expect(diffs[1]).toMatchObject({
      id: "scaled",
      status: "changed",
      recorded: 4,
      replayed: 6,
    });
  });

  it("stops at a step the recording never completed", async () => {
    fixtureApi({ base: 2 });
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(2),
      appName: "app",
      functionSlug: "app-double",
    });

    expect(
      diffs.map((d) => {
        return [d.id, d.status];
      }),
    ).toEqual([
      ["base", "same"],
      ["scaled", "new"],
    ]);
  });

  it("reports a recorded failure that now passes as fixed", async () => {
    fixtureApi({ base: 2, scaled: undefined }, "scaled");
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(2),
      appName: "app",
      functionSlug: "app-double",
    });

    expect(
      diffs.map((d) => {
        return [d.id, d.status];
      }),
    ).toEqual([
      ["base", "same"],
      ["scaled", "fixed"],
    ]);
  });

  it("reports recorded steps the new code never reaches", async () => {
    fixtureApi({ base: 2, scaled: 4, extra: 1 });
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(2),
      appName: "app",
      functionSlug: "app-double",
    });

    expect(diffs[2]).toMatchObject({ id: "extra", status: "missing" });
  });

  it("fails loudly on a response of an unexpected shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ data: { id: "RUN1" } }));
      }),
    );

    await expect(fetchRecordedRun(fetchOpts)).rejects.toThrow(
      /Unexpected API response/,
    );
  });

  it("stops after the requested step", async () => {
    fixtureApi({ base: 2, scaled: 4 });
    const recorded = await fetchRecordedRun(fetchOpts);

    const diffs = await replayRun({
      recorded,
      handler: build(3),
      appName: "app",
      functionSlug: "app-double",
      stopAfter: "base",
    });

    expect(diffs).toHaveLength(1);
  });

  it("says so when the server stored no step outputs", async () => {
    fixtureApi({ base: undefined, scaled: undefined });

    await expect(fetchRecordedRun(fetchOpts)).rejects.toThrow(PullDataError);
    await expect(fetchRecordedRun(fetchOpts)).rejects.toThrow(
      /no recorded step outputs/,
    );
  });

  it("writes a fixture and an @inngest/test scaffold", async () => {
    fixtureApi({ base: 2, scaled: 4 });
    const recorded = await fetchRecordedRun(fetchOpts);
    const dir = await mkdtemp(join(tmpdir(), "pull-"));
    const testPath = join(dir, "double.test.ts");

    const { fixturePath, target } = await writeTestScaffold({
      recorded,
      testPath,
      step: "scaled",
    });

    expect(target).toBe("scaled");
    expect(JSON.parse(await readFile(fixturePath, "utf8"))).toMatchObject({
      runId: "RUN1",
      target: "scaled",
      events: [event],
      steps: [
        { id: "base", data: 2 },
        { id: "scaled", data: 4 },
      ],
    });

    const test = await readFile(testPath, "utf8");
    expect(test).toContain('from "@inngest/test"');
    expect(test).toContain('from "./double.test.fixture.json"');
    expect(test).toContain("t.executeStep(fixture.target");
  });
});
