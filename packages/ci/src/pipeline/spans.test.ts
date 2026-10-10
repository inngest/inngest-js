/**
 * Tests of the span helpers, and of CI on an SDK without the span API: with
 * none, functions still run, step IDs and names are exactly what they are
 * with it, and the trace just has no spans or origins. The same goes for an
 * SDK that doesn't take a snapshot's own span. The rest of the suite runs
 * with the test stub in place.
 *
 * @module
 */

import { group, step } from "inngest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { $ } from "../machine/command.ts";
import { snapshotMachine } from "../machine/machine.ts";
import { ciTest } from "../testing/harness.ts";
import { installSpanStub, removeSpanStub } from "../testing/spanStub.ts";
import { ciOrigin } from "./names.ts";
import type { CiJobScope } from "./scope.ts";
import {
  hasSpanApi,
  inSnapshotSpan,
  inSpan,
  originOption,
  sdk,
  snapshotSpanOption,
  versionAtLeast,
} from "./spans.ts";

/** Run a job with a command and a step of your own. */
const run = () => {
  return ciTest().run((ci) => {
    return ci.job("test", async () => {
      await $`pnpm test`;

      await step.run("mine", () => {
        return "done";
      });
    });
  });
};

const span = { id: "a", name: "A", kind: "job" } as const;

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

    // Origins aren't asserted absent: an SDK with the span API stamps a
    // step's `~origin` option itself, whether or not `group["~span"]` is there
    // to open spans, and this suite runs against that SDK.
  });
});

describe("with the SDK's span API", () => {
  test("is detected, and inSpan hands it the span and the function", () => {
    expect(hasSpanApi()).toBe(true);

    removeSpanStub();

    const calls: unknown[] = [];

    Object.defineProperty(group, "~span", {
      value: (opened: unknown, fn: () => unknown) => {
        calls.push(opened);

        return `wrapped ${String(fn())}`;
      },
      configurable: true,
    });

    try {
      expect(inSpan(span, () => "inner")).toBe("wrapped inner");

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

describe("versionAtLeast", () => {
  test.each([
    ["4.23.1", true],
    ["4.23.2", true],
    ["4.24.0", true],
    ["5.0.0", true],
    ["4.23.1-pr.1", true],
    ["4.23.0", false],
    ["4.22.9", false],
    ["3.99.99", false],
  ])("%s", (version, expected) => {
    expect(versionAtLeast(version, "4.23.1")).toBe(expected);
  });
});

describe("a snapshot's span", () => {
  /** What a job's snapshot passes the SDK, and the spans opened around it. */
  const snapshotWith = async (takesSpan: boolean) => {
    vi.spyOn(sdk, "takesSnapshotSpan").mockReturnValue(takesSpan);

    const steps: unknown[] = [];
    const opened: unknown[] = [];

    const open = vi.fn((spanned: unknown, fn: () => unknown) => {
      opened.push(spanned);

      return fn();
    });

    Object.defineProperty(group, "~span", {
      value: open,
      configurable: true,
    });

    const scope = {
      path: "test",
      machine: Promise.resolve({
        sandbox: {
          snapshot: (options: unknown) => {
            steps.push(options);

            return Promise.resolve({ id: "snap" });
          },
        },
      }),
      run: { ci: { hooks: { activity: vi.fn() } } },
    } as unknown as CiJobScope;

    try {
      await snapshotMachine(scope);
    } finally {
      Reflect.deleteProperty(group, "~span");

      installSpanStub();

      vi.restoreAllMocks();
    }

    return { steps, opened };
  };

  const save = {
    id: "test › save",
    name: "Save sandbox",
    kind: "snapshot",
    origin: ciOrigin,
  };

  test("goes to an SDK that takes it, as the step's own span", async () => {
    removeSpanStub();

    const { steps, opened } = await snapshotWith(true);

    expect(steps).toEqual([
      expect.objectContaining({ id: "test › snapshot", "~span": save }),
    ]);

    expect(opened).toEqual([]);
  });

  test("is opened here for an SDK that doesn't, which would open its own", async () => {
    removeSpanStub();

    const { steps, opened } = await snapshotWith(false);

    expect(steps).toEqual([expect.not.objectContaining({ "~span": save })]);

    expect(opened).toEqual([save]);
  });

  test("is a step option only where the SDK takes it", () => {
    vi.spyOn(sdk, "takesSnapshotSpan").mockReturnValue(true);

    expect(snapshotSpanOption(span)).toEqual({ "~span": span });

    vi.spyOn(sdk, "takesSnapshotSpan").mockReturnValue(false);

    expect(snapshotSpanOption(span)).toEqual({});

    expect(inSnapshotSpan(span, () => "ran")).toBe("ran");

    vi.restoreAllMocks();
  });
});
