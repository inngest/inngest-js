/**
 * Tests of telling a Sandbox access problem from any other failure.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { sandboxAccessError, sandboxAccessProblem } from "./sandboxAccess.ts";

describe("sandboxAccessProblem", () => {
  test.each([
    ["cloud_login_required", "login"],
    ["not logged in to Inngest", "login"],
    ["environment_required", "environment"],
    ["no Inngest environment selected", "environment"],
    ["access_denied", "plan"],
    ["Sandboxes not enabled for your account", "plan"],
    ["`pnpm test` exited with 1", undefined],
    [undefined, undefined],
  ])("%s is %s", (text, problem) => {
    expect(sandboxAccessProblem(text)).toBe(problem);
  });

  test("each problem has numbered steps and a link", () => {
    const error = sandboxAccessError("login");

    expect(error.fix).toContain("1. Run  npx inngest-cli@latest login");
    expect(error.fix).toContain("2. Run  inngest-ci  again");
    expect(error.fix).toContain("https://www.inngest.com/docs/sandboxes");
  });
});
