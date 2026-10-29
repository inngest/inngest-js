/**
 * @module
 * Tests for agent limits: narrowing, the allow-list, refusals and the budget.
 */

import {
  AgentLimitError,
  budgetReason,
  checkInvoke,
  childLimits,
  type LimitState,
  matchesTarget,
  narrowInherited,
  narrowLimits,
  readInheritedLimits,
} from "./limits.ts";
import type { AgentUsage } from "./loop.ts";

const state = (
  limits: LimitState["limits"],
  used: AgentUsage = { input: 0, output: 0 },
  spawned = 0,
): LimitState => {
  return { limits, used, spawned };
};

const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error as AgentLimitError;
  }

  throw new Error("expected a refusal");
};

describe("matchesTarget", () => {
  test("matches whole targets, with * for any text", () => {
    expect(matchesTarget("app/a", "app/a")).toBe(true);
    expect(matchesTarget("app/a", "app/ab")).toBe(false);
    expect(matchesTarget("app/*", "app/anything")).toBe(true);
    expect(matchesTarget("*/scout", "x/scout")).toBe(true);
    expect(matchesTarget("a.b/c", "aXb/c")).toBe(false);
  });
});

describe("narrowLimits", () => {
  test("depth defaults to 1 and an inherited cap wins when lower", () => {
    expect(narrowLimits(undefined, undefined).depth).toBe(1);
    expect(narrowLimits({ depth: 3 }, { depth: 1 }).depth).toBe(1);
    expect(narrowLimits({ depth: 1 }, { depth: 5 }).depth).toBe(1);
    expect(narrowLimits(undefined, { depth: 0 }).depth).toBe(0);
  });

  test("spawn and budget take the lower value, field by field", () => {
    const narrowed = narrowLimits(
      { spawn: 5, budget: { tokens: 100, output: 10 } },
      { spawn: 2, budget: { tokens: 500, input: 50 } },
    );

    expect(narrowed.spawn).toBe(2);
    expect(narrowed.budget).toEqual({ tokens: 100, input: 50, output: 10 });
  });

  test("mayCall keeps every list of the chain", () => {
    const narrowed = narrowLimits({ mayCall: ["a/*"] }, { mayCall: [["a/x"]] });

    expect(narrowed.mayCall).toEqual([["a/x"], ["a/*"]]);
  });
});

describe("readInheritedLimits", () => {
  test("closes anything malformed rather than widening it", () => {
    expect(readInheritedLimits(undefined)).toBeUndefined();
    expect(readInheritedLimits({ limits: "x" })).toEqual({ depth: 0 });
    expect(
      readInheritedLimits({
        limits: {
          depth: "2",
          mayCall: [["a/*", 3], "b"],
          budget: { tokens: 5, input: "x" },
        },
      }),
    ).toEqual({
      depth: 0,
      mayCall: [["a/*"], []],
      budget: { tokens: 5, input: 0 },
    });
  });
});

describe("checkInvoke", () => {
  test("refuses past depth with a readable message", () => {
    const error = refusal(() => {
      checkInvoke(state({ depth: 0 }), "app/leaf");
    });

    expect(error).toBeInstanceOf(AgentLimitError);
    expect(error.limit).toBe("depth");
    expect(error.message).toContain("app/leaf was not started");
  });

  test("refuses the call after spawn calls", () => {
    checkInvoke(state({ spawn: 2 }, undefined, 1), "app/a");

    expect(
      refusal(() => {
        checkInvoke(state({ spawn: 2 }, undefined, 2), "app/a");
      }).limit,
    ).toBe("spawn");
  });

  test("refuses a target outside any mayCall list", () => {
    const limits = { mayCall: [["app/*"], ["app/a"]] };

    checkInvoke(state(limits), "app/a");

    const error = refusal(() => {
      checkInvoke(state(limits), "app/b");
    });

    expect(error.limit).toBe("mayCall");
    expect(error.message).toContain("app/a");
  });

  test("refuses once the budget is spent", () => {
    const error = refusal(() => {
      checkInvoke(
        state({ budget: { tokens: 10 } }, { input: 6, output: 4 }),
        "app/a",
      );
    });

    expect(error.limit).toBe("budget");
  });
});

describe("usd budget", () => {
  test("is spent when the dollars reach it, and says so in dollars", () => {
    const limits = { budget: { usd: 0.02 } };

    expect(
      budgetReason(state(limits, { input: 9, output: 9, usd: 0.0199 })),
    ).toBe(undefined);
    expect(
      budgetReason(state(limits, { input: 0, output: 0, usd: 0.02 })),
    ).toBe("Budget spent: $0.02 of $0.02 used.");
    expect(
      budgetReason(
        state(
          { budget: { usd: 0.00002 } },
          { input: 1, output: 1, usd: 0.00003 },
        ),
      ),
    ).toBe("Budget spent: $0.000030 of $0.000020 used.");
  });

  test("a budget with dollars but no priced usage is never spent", () => {
    expect(
      budgetReason(state({ budget: { usd: 1 } }, { input: 1e9, output: 1e9 })),
    ).toBeUndefined();
  });

  test("narrows with the other fields, passes down what is left, and a bad payload closes it", () => {
    expect(
      narrowLimits({ budget: { usd: 5 } }, { budget: { usd: 3, tokens: 9 } })
        .budget,
    ).toEqual({ usd: 3, tokens: 9 });
    expect(
      childLimits(
        state({ budget: { usd: 1 } }, { input: 1, output: 1, usd: 0.25 }),
      ).budget,
    ).toEqual({ usd: 0.75 });
    expect(
      childLimits(
        state({ budget: { usd: 1 } }, { input: 1, output: 1, usd: 4 }),
      ).budget,
    ).toEqual({ usd: 0 });
    expect(
      readInheritedLimits({ limits: { budget: { usd: "lots" } } })?.budget,
    ).toEqual({ usd: 0 });
  });
});

describe("budget", () => {
  test("reports the field that is spent", () => {
    const limits = { budget: { output: 5 } };

    expect(budgetReason(state(limits, { input: 100, output: 4 }))).toBe(
      undefined,
    );
    expect(budgetReason(state(limits, { input: 0, output: 5 }))).toContain(
      "5 of 5 output tokens",
    );
  });

  test("a child gets one less depth and what is left", () => {
    const child = childLimits(
      state(
        { depth: 2, spawn: 3, mayCall: [["a/*"]], budget: { tokens: 100 } },
        { input: 30, output: 20 },
      ),
    );

    expect(child).toEqual({
      depth: 1,
      spawn: 3,
      mayCall: [["a/*"]],
      budget: { tokens: 50 },
    });
  });
});

describe("hardening", () => {
  test("a present but malformed container closes the limit", () => {
    expect(
      readInheritedLimits({ limits: { mayCall: "x", budget: "y" } }),
    ).toEqual({ mayCall: [[]], budget: { tokens: 0 } });
  });

  test("starting a thread again with the same limits adds no duplicate list", () => {
    const limits = { mayCall: [["a/*"]] };

    expect(narrowInherited(limits, limits)?.mayCall).toEqual([["a/*"]]);
  });
});

test("Infinity in a config limit means no cap", () => {
  expect(
    narrowLimits({ depth: Number.POSITIVE_INFINITY }, undefined).depth,
  ).toBe(1);
  expect(
    narrowLimits({ spawn: Number.POSITIVE_INFINITY }, { spawn: 3 }).spawn,
  ).toBe(3);
});
