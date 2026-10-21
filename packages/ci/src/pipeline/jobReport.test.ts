import { describe, expect, it } from "vitest";
import { CommandFailedError, CommandTimeoutError } from "../errors.ts";
import {
  failedPayload,
  failureOf,
  passedPayload,
  runningPayload,
} from "./jobReport.ts";
import type { CiJobScope } from "./scope.ts";

const scope = (overrides: Partial<CiJobScope> = {}): CiJobScope => {
  return {
    run: {
      runId: "01RUN",
      functionId: "pr",
      cacheSaved: new Map([["build", 41_000]]),
      ci: { runUrl: ({ runId }: { runId: string }) => `https://app/${runId}` },
      repo: {
        owner: "o",
        name: "r",
        fullName: "o/r",
        sha: "5fed4bf1234",
        pullRequest: { number: 1819, headRef: "x", fork: false },
      },
    },
    path: "test",
    jobPath: "test",
    config: { id: "test" },
    commands: [],
    summaries: [],
    annotations: [],
    ...overrides,
  } as unknown as CiJobScope;
};

const failure = (stdout: string, stderr = "", exitCode = 1) => {
  return new CommandFailedError({
    command: ["pnpm", "test"],
    exitCode,
    stdoutTail: stdout,
    stderrTail: stderr,
    jobPath: "test",
  });
};

describe("failureOf", () => {
  it("tells a test failure with its counts and the lines that failed", () => {
    const result = failureOf(
      failure(
        [
          " FAIL  src/a.test.ts > tags the run id",
          "AssertionError: expected undefined to be 'x'",
          " ❯ src/a.test.ts:42:31",
          "      Tests  2 failed | 146 passed (148)",
        ].join("\n"),
      ),
      scope({ cwd: "/work/packages/x" }),
    );

    expect(result.errorClass).toBe("test");
    expect(result.headline).toBe(
      "**2 tests failed**, 146 passed, in `pnpm test` (exit 1).",
    );
    expect(result.open?.[0]?.label).toBe("`a.test.ts:42`");
    expect(result.open?.[0]?.url).toBe(
      "https://github.com/o/r/blob/5fed4bf1234/packages/x/src/a.test.ts#L42",
    );
    expect(result.excerpt?.some((line) => line.bad)).toBe(true);
  });

  it("tells type errors, mapping paths from the cwd to the repository", () => {
    const result = failureOf(
      failure(
        "src/b.ts(3,4): error TS2345: Argument of type 'a' is not assignable.\nsrc/c.ts(9,1): error TS2322: bad",
      ),
      scope({ cwd: "/work/packages/ci" }),
    );

    expect(result.errorClass).toBe("code");
    expect(result.headline).toBe("**2 type errors** in `pnpm test` (exit 1).");
    expect(result.open?.map((place) => place.label)).toEqual([
      "`b.ts:3`",
      "`c.ts:9`",
    ]);
    expect(result.open?.[0]?.url).toContain("packages/ci/src/b.ts#L3");
  });

  it("calls a Dev Server timeout probably infrastructure and says no test ran", () => {
    const result = failureOf(
      failure(
        "Error: Dev Server startup timed out after 60 seconds\nNo test files found, exiting with code 1\nclose timed out after 10000ms",
      ),
      scope(),
    );

    expect(result.errorClass).toBe("infra");
    expect(result.title).toBe(
      "Error: Dev Server startup timed out after 60 seconds (exit 1)",
    );
    expect(result.headline).toContain(
      "**Probably infrastructure, not your change.**",
    );
    expect(result.headline).toContain("so **no test ran**");
    expect(result.notes?.[0]).toContain("close timed out");
  });

  it("says a killed process probably ran out of memory", () => {
    const result = failureOf(failure("", "Killed", 137), scope());

    expect(result.errorClass).toBe("oom");
    expect(result.headline).toContain("probably out of memory");
  });

  it("tells a command timeout", () => {
    const result = failureOf(
      new CommandTimeoutError({
        command: ["pnpm", "test"],
        timeout: "15m",
        jobPath: "test",
      }),
      scope(),
    );

    expect(result.errorClass).toBe("timeout");
    expect(result.title).toBe("Timed out: `pnpm test` ran past its 15m limit");
  });

  it("tells any other error with its first lines", () => {
    const result = failureOf(new Error("it broke\nat somewhere"), scope());

    expect(result.errorClass).toBe("failure");
    expect(result.excerpt?.map((line) => line.text)).toEqual([
      "it broke",
      "at somewhere",
    ]);
  });

  it("never throws for something that is not an error", () => {
    expect(failureOf("just a string", scope()).errorClass).toBe("failure");
    expect(failureOf(undefined, scope()).errorClass).toBe("failure");
  });
});

describe("a job's payloads", () => {
  it("a running job lists its commands", () => {
    const payload = runningPayload(
      scope({
        commands: [
          { state: "done", command: "pnpm install" },
          { state: "running", command: "pnpm test" },
        ],
      }),
      90_000,
    );

    expect(payload.title).toBe("🔄 Running `pnpm test`");
    expect(payload.summary).toContain("| ✅ | `pnpm install` |");
    expect(payload.actions.map((action) => action.identifier)).toEqual([
      "cancel",
    ]);
  });

  it("a passed job that started from a reused parent says what it saved", () => {
    const payload = passedPayload(
      scope({ fromParent: { id: "build", reused: true } }),
      157_000,
    );

    expect(payload.title).toBe("✅ Passed in 2m 37s · ⚡ 41s saved by cache");
    expect(payload.summary).toContain("**41s saved**");
  });

  it("a passed job whose parent was built here saved nothing", () => {
    const payload = passedPayload(
      scope({ fromParent: { id: "build", reused: false } }),
      1000,
    );

    expect(payload.title).toBe("✅ Passed in 1s");
  });

  it("a failed job carries both re-run buttons", () => {
    const { payload, failure: told } = failedPayload(
      scope(),
      failure("boom"),
      1000,
    );

    expect(told.errorClass).toBe("failure");
    expect(payload.actions.map((action) => action.identifier)).toEqual([
      "rerun",
      "rerun-fresh",
    ]);
  });
});
