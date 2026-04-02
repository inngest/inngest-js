import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import { createStepToolFilter } from "./filter.js";

function makeMockCtx(stepKeys: string[]) {
  const step: Record<string, unknown> = {};
  for (const key of stepKeys) {
    step[key] = () => `${key}-result`;
  }
  return {
    event: { name: "test", data: {}, ts: Date.now() },
    events: [{ name: "test", data: {}, ts: Date.now() }],
    runId: "run-1",
    attempt: 0,
    step,
    group: {},
  } as any;
}

describe("createStepToolFilter", () => {
  it("should keep allowed tools unchanged", () => {
    const filter = createStepToolFilter(["run", "sleep"]);
    const ctx = makeMockCtx(["run", "sleep", "invoke"]);
    const filtered = filter(ctx);

    expect((filtered.step as any).run()).toBe("run-result");
    expect((filtered.step as any).sleep()).toBe("sleep-result");
  });

  it("should replace disallowed tools with error-throwing stubs", () => {
    const filter = createStepToolFilter(["run"]);
    const ctx = makeMockCtx(["run", "sleep", "invoke"]);
    const filtered = filter(ctx);

    expect(() => (filtered.step as any).sleep()).toThrow(NonRetriableError);
    expect(() => (filtered.step as any).invoke()).toThrow(NonRetriableError);
  });

  it("should include tool name in error message", () => {
    const filter = createStepToolFilter(["run"]);
    const ctx = makeMockCtx(["run", "sleep"]);
    const filtered = filter(ctx);

    expect(() => (filtered.step as any).sleep()).toThrow(
      /Step tool "sleep" is not available/
    );
  });

  it("should list allowed tools in error message", () => {
    const filter = createStepToolFilter(["run", "sendEvent"]);
    const ctx = makeMockCtx(["run", "sendEvent", "invoke"]);
    const filtered = filter(ctx);

    expect(() => (filtered.step as any).invoke()).toThrow(
      /Allowed: run, sendEvent/
    );
  });

  it("should preserve non-step context fields", () => {
    const filter = createStepToolFilter(["run"]);
    const ctx = makeMockCtx(["run"]);
    ctx.runId = "preserve-me";
    ctx.attempt = 5;

    const filtered = filter(ctx);
    expect(filtered.runId).toBe("preserve-me");
    expect(filtered.attempt).toBe(5);
  });

  it("should handle empty allowed list", () => {
    const filter = createStepToolFilter([]);
    const ctx = makeMockCtx(["run", "sleep"]);
    const filtered = filter(ctx);

    expect(() => (filtered.step as any).run()).toThrow(NonRetriableError);
    expect(() => (filtered.step as any).sleep()).toThrow(NonRetriableError);
  });
});
