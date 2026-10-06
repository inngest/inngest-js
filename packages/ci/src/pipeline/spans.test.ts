/**
 * Tests of the span helpers, and of CI on an SDK without the span API: with
 * none, functions still run, step IDs and names are exactly what they are
 * with it, and the trace just has no spans or origins. The rest of the suite
 * runs with the test stub in place.
 *
 * @module
 */

import { group, step } from "inngest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { installSpanStub, removeSpanStub } from "../testing/spanStub.ts";
import { createCi } from "./createCi.ts";
import { hasSpanApi, inSpan, originOption } from "./spans.ts";

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

/** Run a job with a command and a step of your own. */
const run = () => {
  const ci = createCi(createCiTestClient(createFakeSandboxApi()), {
    github: consoleReporter(),
  });

  const job: () => Promise<unknown> = ci.job("test", async () => {
    await $`pnpm test`;

    await step.run("mine", () => {
      return "done";
    });
  });

  const pipeline = ci.pipeline(
    { id: "pr", on: [{ event: "github/pull_request.opened" }] },
    job,
  );

  return runFunction(pipeline, { event: prEvent });
};

describe("without the SDK's span API", () => {
  beforeEach(() => {
    removeSpanStub();
  });

  afterEach(() => {
    installSpanStub();
  });

  test("is detected as absent", () => {
    expect(hasSpanApi()).toBe(false);

    expect("~span" in group).toBe(false);
  });

  test("inSpan runs the function and returns what it returns", async () => {
    const span = { id: "a", name: "A" };

    expect(inSpan(span, () => 7)).toBe(7);

    await expect(
      inSpan(span, () => {
        return Promise.resolve("later");
      }),
    ).resolves.toBe("later");

    expect(() => {
      return inSpan(span, () => {
        throw new Error("from fn");
      });
    }).toThrow("from fn");
  });

  test("steps keep their IDs and names, and the trace has no spans", async () => {
    installSpanStub();

    const withSpans = await run();

    removeSpanStub();

    const without = await run();

    expect(without.type).toBe("function-resolved");

    expect(without.stepIds).toEqual(withSpans.stepIds);
    expect(without.names).toEqual(withSpans.names);

    expect(without.stepIds).toContain("test › pnpm test › start");
    expect(without.names["test › pnpm test › start"]).toBe("Start process");

    expect(Object.keys(withSpans.spans).length).toBeGreaterThan(0);
    expect(without.spans).toEqual({});
    expect(without.origins).toEqual({});
  });
});

describe("with the SDK's span API", () => {
  test("is detected, and inSpan hands it the span and the function", () => {
    expect(hasSpanApi()).toBe(true);

    removeSpanStub();

    const calls: unknown[] = [];

    Object.defineProperty(group, "~span", {
      value: (span: unknown, fn: () => unknown) => {
        calls.push(span);

        return `wrapped ${String(fn())}`;
      },
      configurable: true,
    });

    try {
      const span = { id: "a", name: "A", kind: "job" };

      expect(
        inSpan(span, () => {
          return "inner";
        }),
      ).toBe("wrapped inner");

      expect(calls).toEqual([span]);
    } finally {
      Reflect.deleteProperty(group, "~span");

      installSpanStub();
    }
  });
});

describe("originOption", () => {
  test("is an extra key on the step options, and nothing else", () => {
    expect({ id: "a", name: "A", ...originOption("x") }).toEqual({
      id: "a",
      name: "A",
      "~origin": "x",
    });
  });
});
