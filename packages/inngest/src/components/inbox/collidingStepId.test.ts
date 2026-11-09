/**
 * @module
 * Tests that a step the user named the way an inbox's ops used to be named
 * cannot take their identity. A read has to know the ID of its own op before
 * that op exists, so it cannot learn the one the engine settled on the way the
 * open does: naming the ops beside the inbox's own ID let a user's step hold
 * the ID a read was about to scan for, and the read never saw its message.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { hashedStepId } from "../execution/inboxState.ts";
import { Inngest } from "../Inngest.ts";

const open = hashedStepId("inbox");

// The step the user named, which used to be the first read's op.
const userStep = hashedStepId("inbox:next");

// A run that finishes in this pass resolves; one that reported ops carries the
// completion among them. Either way this is what the handler returned.
const returned = (result: unknown): unknown => {
  const r = result as {
    data?: unknown;
    steps?: { op: string; data?: unknown }[];
  };

  return r.steps?.find((step) => step.op === "RunComplete")?.data ?? r.data;
};

const read = (userStepId: string) => {
  return new Inngest({ id: testClientId, isDev: true }).createFunction(
    { id: "colliding", triggers: [{ event: "colliding/run" }] },
    async ({ step }) => {
      const inbox = step.subscribe("inbox", "msg");
      await step.run(userStepId, () => "done");

      return (await inbox.next())?.data;
    },
  );
};

describe("a user step named like an inbox op", () => {
  test("a step named `<inbox>:next` does not hide the read's message", async () => {
    const result = await runFnWithStack(read("inbox:next"), {
      [open]: { id: open, data: { pauses: [] } },
      [userStep]: { id: userStep, data: "done" },
      m1: {
        id: "m1",
        data: { data: { name: "msg", data: { n: 1 } }, "inngest/inbox": open },
      },
    });

    expect(returned(result)).toEqual({ n: 1 });
  });

  // A read only asks whether its inbox is closed when it has nothing to read,
  // so this one is given no message: it must report a wait rather than end.
  test("a step named `<inbox>:close` does not make the inbox look closed", async () => {
    const closeStep = hashedStepId("inbox:close");

    const result = await runFnWithStack(read("inbox:close"), {
      [open]: { id: open, data: { pauses: [] } },
      [closeStep]: { id: closeStep, data: "done" },
    });

    expect(result).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          op: "SubscribeWait",
          id: hashedStepId("inngest/inbox/inbox/next/0"),
        }),
      ]),
    });
  });
});
