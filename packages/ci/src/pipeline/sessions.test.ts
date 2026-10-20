/**
 * Tests of the Inngest Sessions CI sets on what it starts: the pipeline run
 * on every child run and build request, and the image on a cached job's build.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { busOf, createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { buildRequestedEvent } from "./buildLock.ts";
import { createCi } from "./createCi.ts";
import type { CiRunScope } from "./scope.ts";
import { sessionsMeta } from "./sessions.ts";

const setup = () => {
  const client = createCiTestClient(createFakeSandboxApi());
  const bus = busOf(client);

  if (!bus) {
    throw new Error("the test client has no bus");
  }

  return { bus, ci: createCi(client, { github: consoleReporter() }) };
};

describe("sessions", () => {
  test("a job's own run is in the pipeline run's session", async () => {
    const { ci } = setup();

    const lint = ci.job("lint", async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01ROOT",
    });

    expect(result.inputs["lint › build"]).toMatchObject({
      payload: { meta: { sessions: { ci_run: "01ROOT" } } },
    });
  });

  test("a cached job's build request is in the pipeline run's and the image's sessions", async () => {
    const { bus, ci } = setup();

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await install();
    });

    await runFunction(pipeline, { event: prEvent, runId: "01ROOT" });

    const [request] = bus.sent.filter((event) => {
      return event.name === buildRequestedEvent;
    });

    expect(request?.meta?.sessions).toEqual({
      ci_run: "01ROOT",
      image: expect.stringMatching(/^install@[0-9a-f]+\/[0-9a-f]+$/),
    });
  });

  test("a cached job built in a run of its own has the image session on its invoke", async () => {
    const { ci } = setup();

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const leaf = ci.job(
      { id: "leaf", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm test`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await leaf();
    });

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01ROOT",
    });

    expect(result.inputs["leaf › build"]).toMatchObject({
      payload: {
        meta: {
          sessions: {
            ci_run: "01ROOT",
            image: expect.stringMatching(/^leaf@[0-9a-f]+\/[0-9a-f]+$/),
          },
        },
      },
    });
  });

  test("the trigger's sessions are carried to the job's run beside ci_run", async () => {
    const { ci } = setup();

    const lint = ci.job("lint", async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const sessions = {
      pull_request: "inngest/inngest-js#7",
      commit: "abc1234",
    };

    const result = await runFunction(pipeline, {
      event: { ...prEvent, meta: { sessions } },
      runId: "01ROOT",
    });

    expect(result.inputs["lint › build"]).toMatchObject({
      payload: {
        meta: {
          sessions: { ci_run: "01ROOT" },
          propagated_sessions: sessions,
        },
      },
    });
  });

  test("an image ID too long in bytes is shortened with its key kept whole", () => {
    const run = { runId: "01ROOT" } as CiRunScope;
    const ownKey = "b472eb37/187f51802a0f760c";

    const { image } = sessionsMeta(run, {
      jobId: "ビルド".repeat(100),
      target: { ownKey, key: {}, name: "ci/x" },
    }).sessions;

    expect(Buffer.byteLength(image as string)).toBeLessThanOrEqual(512);
    expect(image).toMatch(/^ビルド.*-[0-9a-f]{8}@b472eb37\/187f51802a0f760c$/);
  });
});
