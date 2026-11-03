/**
 * @module
 * Tests for `step.subscribe` called twice with the same ID in one run, such as
 * a loop that opens an inbox, reads it and closes it. The engine gives the
 * second opening step a collision suffix (`inbox:1`), and the inbox is that
 * step's: its identity and the ops of its reads and close come from the final
 * ID, never from the ID the user wrote.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { hashedStepId } from "../execution/inboxState.ts";
import { Inngest } from "../Inngest.ts";
import { withStepIdPrefix } from "../InngestStepTools.ts";

const firstOpen = hashedStepId("inbox");
const secondOpen = hashedStepId("inbox:1");

const message = (opener: string, name: string, n: number) => {
  return {
    data: { name, data: { n } },
    "inngest/inbox": opener,
  };
};

const sequential = () => {
  return new Inngest({ id: testClientId, isDev: true }).createFunction(
    { id: "repeated", triggers: [{ event: "repeated/run" }] },
    async ({ step }) => {
      const first = step.subscribe("inbox", "msg");
      const a = await first.next();
      await first.close();

      const second = step.subscribe("inbox", "msg");
      const b = await second.next();

      return { a, b };
    },
  );
};

describe("step.subscribe with an ID the run already used", () => {
  test("the second inbox reads its own messages, not the first's", async () => {
    const closeFirst = hashedStepId("inbox:close");
    const result = await runFnWithStack(sequential(), {
      [firstOpen]: { id: firstOpen, data: { pauses: [] } },
      m1: { id: "m1", data: message(firstOpen, "msg", 1) },
      [closeFirst]: { id: closeFirst, data: { cut: "m1" } },
      [secondOpen]: { id: secondOpen, data: { pauses: [] } },
      m2: { id: "m2", data: message(secondOpen, "msg", 2) },
    });

    expect(result).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          op: "RunComplete",
          data: {
            a: { name: "msg", data: { n: 1 } },
            b: { name: "msg", data: { n: 2 } },
          },
        }),
      ]),
    });
  });

  test("the second inbox's wait and close name its own opening step", async () => {
    const closeFirst = hashedStepId("inbox:close");
    const fn = new Inngest({ id: testClientId, isDev: true }).createFunction(
      { id: "repeated-ops", triggers: [{ event: "repeated/ops" }] },
      async ({ step }) => {
        const first = step.subscribe("inbox", "msg");
        await first.next();
        await first.close();

        const second = step.subscribe("inbox", "msg");

        return second.next({ timeout: "1m" });
      },
    );

    const result = await runFnWithStack(fn, {
      [firstOpen]: { id: firstOpen, data: { pauses: [] } },
      m1: { id: "m1", data: message(firstOpen, "msg", 1) },
      [closeFirst]: { id: closeFirst, data: { cut: "m1" } },
      [secondOpen]: { id: secondOpen, data: { pauses: [] } },
    });

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [
        {
          id: hashedStepId("inbox:1:next"),
          op: "SubscribeWait",
          opts: { inbox: secondOpen },
        },
      ],
    });
  });

  test("the second inbox's close names its own opening step", async () => {
    const closeFirst = hashedStepId("inbox:close");
    const fn = new Inngest({ id: testClientId, isDev: true }).createFunction(
      { id: "repeated-close", triggers: [{ event: "repeated/close" }] },
      async ({ step }) => {
        const first = step.subscribe("inbox", "msg");
        await first.close();

        const second = step.subscribe("inbox", "msg");

        return second.close();
      },
    );

    const result = await runFnWithStack(fn, {
      [firstOpen]: { id: firstOpen, data: { pauses: [] } },
      [closeFirst]: { id: closeFirst, data: { cut: null } },
      [secondOpen]: { id: secondOpen, data: { pauses: [] } },
    });

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [
        {
          id: hashedStepId("inbox:1:close"),
          op: "SubscribeClose",
          opts: { inbox: secondOpen },
        },
      ],
    });
  });

  test("an inbox opened under a step ID prefix is named from the prefixed ID", async () => {
    const prefixed = hashedStepId("a:inbox");
    const fn = new Inngest({ id: testClientId, isDev: true }).createFunction(
      { id: "prefixed", triggers: [{ event: "prefixed/run" }] },
      async ({ step }) => {
        return withStepIdPrefix("a:", () => {
          return step.subscribe("inbox", "msg").next({ timeout: "1m" });
        });
      },
    );

    const result = await runFnWithStack(fn, {
      [prefixed]: { id: prefixed, data: { pauses: [] } },
    });

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [
        {
          id: hashedStepId("a:inbox:next"),
          op: "SubscribeWait",
          opts: { inbox: prefixed },
        },
      ],
    });
  });
});
