/**
 * @module
 * Tests for agent limits: narrowing, the allow-list, refusals and the budget.
 */

import type { AgentUsage } from "../loop/loop.ts";
import {
  AgentLimitError,
  budgetReason,
  checkInvoke,
  childLimits,
  type LimitState,
  narrowInherited,
  narrowLimits,
  readInheritedLimits,
} from "./limits.ts";

const state = (
  limits: LimitState["limits"],
  used: AgentUsage = { input: 0, output: 0 },
  budget?: LimitState["budget"],
): LimitState => {
  return { limits, used, ...(budget && { budget }) };
};

const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error as AgentLimitError;
  }

  throw new Error("expected a refusal");
};

describe("narrowLimits", () => {
  test("depth defaults to 1 and an inherited cap wins when lower", () => {
    expect(narrowLimits(undefined, undefined).depth).toBe(1);
    expect(narrowLimits({ depth: 3 }, { depth: 1 }).depth).toBe(1);
    expect(narrowLimits({ depth: 1 }, { depth: 5 }).depth).toBe(1);
    expect(narrowLimits(undefined, { depth: 0 }).depth).toBe(0);
  });

  test("a budget in an inherited payload is ignored", () => {
    expect(
      narrowLimits(undefined, { depth: 2, budget: { tokens: 1 } } as never),
    ).toEqual({ depth: 2 });
    expect(
      readInheritedLimits({ limits: { depth: 2, budget: { usd: 1 } } }),
    ).toEqual({ depth: 2 });
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
        },
      }),
    ).toEqual({
      depth: 0,
      mayCall: [["a/*"], []],
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

  test("refuses a target outside any mayCall list", () => {
    const limits = { mayCall: [["app/a", "app/c"], ["app/a"]] };

    checkInvoke(state(limits), "app/a");

    const error = refusal(() => {
      checkInvoke(state(limits), "app/b");
    });

    expect(error.limit).toBe("mayCall");
    expect(error.message).toContain("app/a");
  });

  test("mayCall takes exact addresses: a * is not a pattern", () => {
    const limits = { mayCall: [["app/*"]] };

    expect(
      refusal(() => {
        checkInvoke(state(limits), "app/a");
      }).limit,
    ).toBe("mayCall");
  });

  test("refuses once the budget is spent", () => {
    const error = refusal(() => {
      checkInvoke(state({}, { input: 6, output: 4 }, { tokens: 10 }), "app/a");
    });

    expect(error.limit).toBe("budget");
  });
});

describe("usd budget", () => {
  test("is spent when the dollars reach it, and says so in dollars", () => {
    const budget = { usd: 0.02 };

    expect(
      budgetReason(state({}, { input: 9, output: 9, usd: 0.0199 }, budget)),
    ).toBe(undefined);
    expect(
      budgetReason(state({}, { input: 0, output: 0, usd: 0.02 }, budget)),
    ).toBe("Budget spent: $0.02 of $0.02 used.");
    expect(
      budgetReason(
        state({}, { input: 1, output: 1, usd: 0.00003 }, { usd: 0.00002 }),
      ),
    ).toBe("Budget spent: $0.000030 of $0.000020 used.");
  });

  test("a budget with dollars but no priced usage is never spent", () => {
    expect(
      budgetReason(state({}, { input: 1e9, output: 1e9 }, { usd: 1 })),
    ).toBeUndefined();
  });
});

describe("budget", () => {
  test("reports the field that is spent", () => {
    const budget = { output: 5 };

    expect(budgetReason(state({}, { input: 100, output: 4 }, budget))).toBe(
      undefined,
    );
    expect(budgetReason(state({}, { input: 0, output: 5 }, budget))).toContain(
      "5 of 5 output tokens",
    );
  });

  test("a child gets one less depth and no budget", () => {
    const child = childLimits(
      state(
        { depth: 2, mayCall: [["a/*"]] },
        { input: 30, output: 20 },
        { tokens: 100 },
      ),
    );

    expect(child).toEqual({ depth: 1, mayCall: [["a/*"]] });
  });
});

describe("hardening", () => {
  test("a present but malformed container closes the limit", () => {
    expect(readInheritedLimits({ limits: { mayCall: "x" } })).toEqual({
      mayCall: [[]],
    });
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
});
