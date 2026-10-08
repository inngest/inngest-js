/**
 * Tests for the messages that say Sandboxes can't be used, and for the short
 * reasons made from the errors the Dev Server and Cloud answer with.
 *
 * @module
 */

import { SandboxError } from "inngest/experimental";
import { describe, expect, test } from "vitest";
import { shortReason } from "../util.ts";
import { createPaint } from "./render/format.ts";
import { initialModel, reduce } from "./render/model.ts";
import { plainLines } from "./render/plain.ts";
import { sandboxAccessError, sandboxAccessProblem } from "./sandboxAccess.ts";

const plain = (problem: Parameters<typeof sandboxAccessError>[0]): string => {
  const error = sandboxAccessError(problem);
  const event = {
    kind: "setup-error" as const,
    message: error.message,
    fix: error.fix,
    at: 1,
  };

  return plainLines(
    event,
    reduce(initialModel, event),
    createPaint(false),
  ).join("\n");
};

describe("the messages", () => {
  test("not logged in", () => {
    expect(plain("login")).toBe(
      [
        "error: Inngest CI needs your Inngest account. Every job runs on an Inngest Sandbox, and the local Dev Server isn't logged in.",
        "  fix:",
        "    1. Run  npx inngest-cli@latest login",
        "    2. Run  inngest-ci  again",
        "    Sandboxes: https://www.inngest.com/docs/sandboxes/overview",
      ].join("\n"),
    );
  });

  test("no single environment", () => {
    expect(plain("environment")).toContain(
      "1. Run  npx inngest-cli@latest login --force",
    );
  });

  test("Sandboxes not enabled", () => {
    expect(plain("plan")).toBe(
      [
        "error: Your Inngest account can't use Sandboxes yet. Every job runs on an Inngest Sandbox, and Sandboxes are only available to environments with access enabled.",
        "  fix:",
        "    1. Ask Inngest to enable Sandbox access for your environment",
        "    2. Run  inngest-ci  again",
        "    Access and limits: https://www.inngest.com/docs/sandboxes/limits",
      ].join("\n"),
    );
  });
});

describe("shortReason for access problems", () => {
  const dev = {
    code: "cloud_login_required",
    message: "Run `inngest login` to use Cloud sandboxes from the dev server",
  };

  test("not logged in, from the Dev Server's error", () => {
    expect(shortReason(dev)).toBe("not logged in to Inngest");
    expect(sandboxAccessProblem(dev)).toBe("login");
  });

  test("not logged in, from the SDK's error", () => {
    const error = new SandboxError({ action: "create", status: 401, ...dev });

    expect(shortReason(error)).toBe("not logged in to Inngest");
  });

  test("no environment", () => {
    expect(shortReason({ code: "environment_required", message: "x" })).toBe(
      "no Inngest environment selected",
    );
  });

  test("Sandboxes not enabled, from Cloud's error", () => {
    const error = new SandboxError({
      action: "create",
      status: 403,
      code: "access_denied",
      message: "denied",
    });

    expect(shortReason(error)).toBe("Sandboxes not enabled for your account");
    expect(sandboxAccessProblem(error)).toBe("plan");
  });

  test("short reasons are recognised again", () => {
    expect(sandboxAccessProblem("not logged in to Inngest")).toBe("login");
  });

  test("other errors are not access problems", () => {
    expect(
      sandboxAccessProblem({ code: "sandbox_start_failed", message: "x" }),
    ).toBeUndefined();
  });
});
