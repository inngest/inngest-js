/**
 * @module
 * Tests that `step.subscribe` only exists when the app added
 * `inboxMiddleware()`: the statement is experimental, so a client that did not
 * opt in has no inbox to open.
 */
import { describe, expect, test } from "vitest";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import type { Middleware } from "../middleware/index.ts";
import { inboxMiddleware } from "./middleware.ts";

const run = async (middleware: Middleware.Class[]) => {
  const fn = new Inngest({
    id: testClientId,
    isDev: true,
    middleware,
  }).createFunction(
    { id: "opt-in", triggers: [{ event: "opt-in/run" }] },
    ({ step }) => {
      return "subscribe" in step;
    },
  );

  return runFnWithStack(fn, {});
};

describe("step.subscribe", () => {
  test("is absent without the middleware", async () => {
    await expect(run([])).resolves.toMatchObject({ data: false });
  });

  test("is there with the middleware", async () => {
    await expect(run([inboxMiddleware()])).resolves.toMatchObject({
      data: true,
    });
  });
});
