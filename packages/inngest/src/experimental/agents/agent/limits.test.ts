/**
 * @module
 * Tests for agent limits: narrowing, the allow-list and refusals.
 */

import type { AgentUsage } from "../loop/loop.ts";
import {
  AgentLimitError,
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
): LimitState => {
  return { limits, used };
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

  test("an unknown field in an inherited payload is ignored", () => {
    expect(
      narrowLimits(undefined, { depth: 2, budget: { tokens: 1 } } as never),
    ).toEqual({ depth: 2 });
    expect(
      readInheritedLimits({ limits: { depth: 2, budget: { usd: 1 } } }),
    ).toEqual({ depth: 2 });
  });

  test("discovery keeps every list of the chain, with self resolved", () => {
    const narrowed = narrowLimits(
      undefined,
      { discovery: { agents: [["a/x"]] } },
      { appId: "b", agents: [{ app: "self" }, { address: "c/y" }] },
    );

    expect(narrowed.discovery).toEqual({
      agents: [["a/x"], [{ app: "b" }, "c/y"]],
    });
  });

  test("an agent that sets no discovery list adds none to the chain", () => {
    expect(narrowLimits(undefined, undefined, { appId: "b" }).discovery).toBe(
      undefined,
    );
  });

  test("depth takes the lowest of the chain and the agent's own", () => {
    expect(narrowLimits({ depth: 9 }, { depth: 0 }).depth).toBe(0);
    expect(narrowLimits({ depth: 0 }, { depth: 4 }).depth).toBe(0);
    expect(narrowLimits({ depth: 3 }, { depth: 4 }).depth).toBe(3);
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
          discovery: { agents: [["a/x", 3, { tags: [1] }, { app: "b" }], "b"] },
        },
      }),
    ).toEqual({
      depth: 0,
      discovery: { agents: [["a/x", { app: "b" }], []] },
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
});

describe("hardening", () => {
  test("a present but malformed container closes the limit", () => {
    expect(
      readInheritedLimits({ limits: { discovery: { agents: "x" } } }),
    ).toEqual({
      discovery: { agents: [[]] },
    });
    expect(readInheritedLimits({ limits: { discovery: 1 } })).toEqual({
      discovery: { agents: [[]], tools: [[]] },
    });
  });

  test("starting a thread again with the same limits adds no duplicate list", () => {
    const limits = { discovery: { agents: [["a/x", { app: "b" }]] } };

    expect(narrowInherited(limits, limits)?.discovery?.agents).toEqual([
      ["a/x", { app: "b" }],
    ]);
  });
});

test("Infinity in a config limit means no cap", () => {
  expect(
    narrowLimits({ depth: Number.POSITIVE_INFINITY }, undefined).depth,
  ).toBe(1);
});
