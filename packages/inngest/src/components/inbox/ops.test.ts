/**
 * @module
 * Tests for the ops an inbox reports to the executor: a wait carries the inbox
 * and what the SDK last saw, a batch read adds whether it holds unread messages
 * and `max`, and a close carries only the inbox.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { hashedStepId } from "../execution/inboxState.ts";
import { Inngest } from "../Inngest.ts";

const opened = hashedStepId("inbox");

const run = async (
  read: (inbox: ReturnType<typeof subscribe>) => Promise<unknown>,
) => {
  const fn = new Inngest({ id: testClientId, isDev: true }).createFunction(
    { id: "ops", triggers: [{ event: "ops/run" }] },
    async ({ step }) => {
      return read(subscribe(step));
    },
  );

  return runFnWithStack(fn, {
    [opened]: { id: opened, data: { pauses: [] } },
  });
};

const subscribe = (step: {
  subscribe: (id: string, sources: string) => unknown;
}) => {
  return step.subscribe("inbox", "msg") as {
    next: (o?: { timeout: string }) => Promise<unknown>;
    nextBatch: (o?: { max: number }) => Promise<unknown>;
    close: () => Promise<unknown>;
  };
};

describe("ops of an inbox", () => {
  test("a wait carries the inbox, the last step seen and the timeout, and no filter", async () => {
    const result = await run((inbox) => {
      return inbox.next({ timeout: "1m" });
    });

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [
        {
          op: "SubscribeWait",
          opts: { inbox: opened, seen: opened, timeout: "1m" },
        },
      ],
    });

    const [step] = (result as { steps: { opts: object }[] }).steps;
    expect(Object.keys(step?.opts ?? {})).not.toContain("want");
  });

  test("a batch read carries max and whether the SDK holds unread messages", async () => {
    const result = await run((inbox) => {
      return inbox.nextBatch({ max: 3 });
    });

    expect(result).toMatchObject({
      steps: [
        {
          op: "SubscribeWait",
          opts: { inbox: opened, batch: { max: 3 } },
        },
      ],
    });
  });

  test("a close carries only the inbox", async () => {
    const result = await run((inbox) => {
      return inbox.close();
    });

    expect(result).toMatchObject({
      steps: [{ op: "SubscribeClose", opts: { inbox: opened } }],
    });

    const [step] = (result as { steps: { opts: object }[] }).steps;
    expect(Object.keys(step?.opts ?? {}).sort()).toEqual([
      "inbox",
      "origin",
      "span",
    ]);
  });

  test("every op of a read is one tagged statement group with an inngest origin", async () => {
    const result = await run((inbox) => {
      return inbox.next();
    });

    expect(result).toMatchObject({
      steps: [
        {
          op: "SubscribeWait",
          opts: {
            span: [{ id: "inbox:next", name: "next", kind: "\u2709\uFE0F" }],
            origin: expect.stringMatching(/^inngest@/),
          },
        },
      ],
    });
  });

  test("a batch read and a drain are named for what the user wrote", async () => {
    const batch = await run((inbox) => {
      return inbox.nextBatch();
    });

    expect(batch).toMatchObject({
      steps: [{ opts: { span: [{ id: "inbox:next", name: "nextBatch" }] } }],
    });
  });

  test("a close is a tagged statement group", async () => {
    const result = await run((inbox) => {
      return inbox.close();
    });

    expect(result).toMatchObject({
      steps: [
        {
          op: "SubscribeClose",
          opts: {
            span: [{ id: "inbox:close", name: "close", kind: "\u2709\uFE0F" }],
            origin: expect.stringMatching(/^inngest@/),
          },
        },
      ],
    });
  });
});
