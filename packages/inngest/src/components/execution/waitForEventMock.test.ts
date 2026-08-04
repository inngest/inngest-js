import { InngestTestEngine } from "@inngest/test";
import { expect, it } from "vitest";
import { Inngest } from "../../index.ts";

/**
 * Regression for #1652: InngestTestEngine stores mocked step results as
 * Promises. waitForEvent schema validation must await them before reading
 * `event.name`, otherwise it throws `Event not found in triggers: undefined`.
 */
it("resolves a mocked waitForEvent step via the documented steps option", async () => {
  const inngest = new Inngest({ id: "repro", isDev: true });

  const fn = inngest.createFunction(
    { id: "wait-repro", triggers: [{ event: "demo/started" }] },
    async ({ step }) => {
      const approval = await step.waitForEvent("wait-for-approval", {
        event: "demo/approved",
        timeout: "1d",
      });
      return { approved: approval !== null, data: approval?.data };
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    steps: [
      {
        id: "wait-for-approval",
        handler() {
          return { name: "demo/approved", data: { ok: true } };
        },
      },
    ],
  });

  const { result, error } = await t.execute({
    events: [{ name: "demo/started", data: { id: "1" } }],
  });

  expect(error).toBeUndefined();
  expect(result).toEqual({ approved: true, data: { ok: true } });
});

it("treats a mocked waitForEvent null result as a timeout", async () => {
  const inngest = new Inngest({ id: "repro", isDev: true });

  const fn = inngest.createFunction(
    { id: "wait-timeout", triggers: [{ event: "demo/started" }] },
    async ({ step }) => {
      const approval = await step.waitForEvent("wait-for-approval", {
        event: "demo/approved",
        timeout: "1d",
      });
      return { approved: approval !== null };
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    steps: [
      {
        id: "wait-for-approval",
        handler() {
          return null;
        },
      },
    ],
  });

  const { result, error } = await t.execute({
    events: [{ name: "demo/started", data: { id: "1" } }],
  });

  expect(error).toBeUndefined();
  expect(result).toEqual({ approved: false });
});
