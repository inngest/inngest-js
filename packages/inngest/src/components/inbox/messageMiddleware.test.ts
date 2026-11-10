/**
 * @module
 * Tests that a message read from the run's state goes through `wrapStep`, as
 * every other step's value does. The answer the executor gives a waiting read
 * is a step's value and went through it already, so a read answered from state
 * had to as well: a middleware that serialises on the way out and deserialises
 * on the way in otherwise left the same read handing back a decoded message or
 * a raw one depending on whether the run happened to be waiting.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { hashedStepId } from "../execution/inboxState.ts";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/index.ts";
import { inboxMiddleware } from "./middleware.ts";

const open = hashedStepId("inbox");

// What a serialising middleware leaves in state in place of a Date.
const encoded = { __date: "2026-01-01T00:00:00.000Z" };

class Decode extends Middleware.BaseMiddleware {
  readonly id = "decode";

  override async wrapStep({ next }: Middleware.WrapStepArgs) {
    return revive(await next());
  }
}

const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(revive);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const date = (value as { __date?: unknown }).__date;
  if (typeof date === "string") {
    return new Date(date);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      return [key, revive(inner)];
    }),
  );
};

const message = (n: number) => {
  return {
    data: { name: "msg", data: { n, paidAt: encoded } },
    "inngest/inbox": open,
  };
};

const fn = (read: "next" | "drain") => {
  return new Inngest({
    id: testClientId,
    isDev: true,
    middleware: [inboxMiddleware(), Decode],
  }).createFunction(
    { id: "decoded", triggers: [{ event: "decoded/run" }] },
    async ({ step }) => {
      const inbox = step.subscribe("inbox", "msg");

      const messages =
        read === "next" ? [await inbox.next()] : await inbox.drain();

      return {
        dates: messages.map((m) => {
          return (
            (m as { data?: { paidAt?: unknown } })?.data?.paidAt instanceof Date
          );
        }),
      };
    },
  );
};

// A run that finishes in this pass resolves; one that reported ops carries the
// completion among them. Either way this is what the handler returned.
const returned = (result: unknown): unknown => {
  const r = result as {
    data?: unknown;
    steps?: { op: string; data?: unknown }[];
  };

  return r.steps?.find((step) => step.op === "RunComplete")?.data ?? r.data;
};

describe("a message read from state", () => {
  test("next() hands back a message the middleware decoded", async () => {
    const result = await runFnWithStack(fn("next"), {
      [open]: { id: open, data: { pauses: [] } },
      m1: { id: "m1", data: message(1) },
    });

    expect(returned(result)).toEqual({ dates: [true] });
  });

  test("drain() hands back messages the middleware decoded", async () => {
    const drain = hashedStepId("inngest/inbox/inbox/next/0");

    const result = await runFnWithStack(fn("drain"), {
      [open]: { id: open, data: { pauses: [] } },
      m1: { id: "m1", data: message(1) },
      m2: { id: "m2", data: message(2) },
      [drain]: { id: drain, data: { cut: "m2" } },
    });

    expect(returned(result)).toEqual({ dates: [true, true] });
  });
});
