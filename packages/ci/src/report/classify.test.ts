import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  infraSignal,
  infraSignals,
  testCounts,
} from "./classify.ts";

const failed = (stderr: string, exitCode = 1, stdout = "") => {
  return classifyCommand({ exitCode, stdout, stderr });
};

describe("infraSignals", () => {
  it.each([
    ["Error: Dev Server startup timed out after 60 seconds", "Dev Server"],
    ["read ECONNRESET", "reset"],
    ["connect ETIMEDOUT 1.2.3.4:443", "timed out"],
    ["getaddrinfo ENOTFOUND registry.npmjs.org", "found"],
    ["ENOSPC: no space left on device", "disk"],
    [
      "npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/x",
      "registry",
    ],
    ["registry returned 502", "registry"],
  ])("names %s", (output, word) => {
    expect(infraSignal(output)?.reason).toContain(
      word.toLowerCase() === word ? word : word,
    );
  });

  it("has a test for every entry", () => {
    expect(infraSignals).toHaveLength(6);
  });

  it("does not call an ordinary failure infrastructure", () => {
    expect(infraSignal("AssertionError: expected 1 to be 2")).toBeUndefined();
  });
});

describe("testCounts", () => {
  it("reads vitest's summary line", () => {
    expect(testCounts("      Tests  2 failed | 146 passed (148)")).toEqual({
      failed: 2,
      passed: 146,
    });
  });

  it("reads a summary with colours", () => {
    expect(
      testCounts("\u001b[2m      Tests \u001b[22m 1 failed | 3 passed"),
    ).toEqual({
      failed: 1,
      passed: 3,
    });
  });

  it("is undefined without a summary", () => {
    expect(testCounts("nothing here")).toBeUndefined();
  });
});

describe("classifyCommand", () => {
  it("137 is probably out of memory", () => {
    expect(failed("Killed", 137)).toBe("oom");
  });

  it("124 is a timeout and 143 a signal", () => {
    expect(failed("", 124)).toBe("timeout");
    expect(failed("", 143)).toBe("signal");
  });

  it("failed tests are a test failure", () => {
    expect(failed("", 1, " Tests  2 failed | 5 passed (7)")).toBe("test");
  });

  it("type errors are code", () => {
    expect(failed("src/a.ts(3,4): error TS2345: bad")).toBe("code");
  });

  it("an infrastructure string with no failed test is infra", () => {
    expect(
      failed(
        "Error: Dev Server startup timed out after 60 seconds",
        1,
        " Tests  no tests",
      ),
    ).toBe("infra");
  });

  it("a failed test wins over an infrastructure string in its output", () => {
    expect(failed("ECONNRESET", 1, " Tests  1 failed | 2 passed")).toBe("test");
  });

  it("anything else is a plain failure", () => {
    expect(failed("boom")).toBe("failure");
  });
});
