/**
 * @module
 * Tests for reading subscription messages out of a run's state.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import {
  stepsToBeSeen,
  subscriptionMessageIdPrefix,
  subscriptionMessagePrefix,
  subscriptionMessages,
} from "./subscription.ts";

describe("subscription messages", () => {
  const inbox = subscriptionMessageIdPrefix("inbox");
  const other = subscriptionMessageIdPrefix("other");

  test("the prefix names the subscription", () => {
    expect(inbox.startsWith(subscriptionMessagePrefix)).toBe(true);
    expect(inbox).not.toBe(other);
    expect(inbox).toBe(subscriptionMessageIdPrefix("inbox"));
  });

  test("messages are the subscription's steps in stack order, whatever order the state is in", () => {
    const stack = [
      "step-a",
      `${inbox}evt-2`,
      "step-b",
      `${other}evt-9`,
      `${inbox}evt-1`,
    ];
    const state = {
      [`${inbox}evt-1`]: { data: "first by id, second by stack" },
      [`${inbox}evt-2`]: { data: "first by stack" },
      [`${other}evt-9`]: { data: "elsewhere" },
      "step-a": { data: "not a message" },
    };

    expect(subscriptionMessages("inbox", stack, state)).toEqual([
      "first by stack",
      "first by id, second by stack",
    ]);
    expect(subscriptionMessages("other", stack, state)).toEqual(["elsewhere"]);
    expect(subscriptionMessages("missing", stack, state)).toEqual([]);
  });
});

describe("steps to be seen", () => {
  test("only the IDs of messages are left out, whatever a step returned", () => {
    const message = `${subscriptionMessageIdPrefix("inbox")}evt-1`;

    expect(stepsToBeSeen(["a", message, "b"])).toEqual(["a", "b"]);
  });

  test("a step that returns a string that looks like a message ID is still seen", async () => {
    let memoizationEnds = 0;
    const counting = class extends Middleware.BaseMiddleware {
      readonly id = "test:counting";

      override onMemoizationEnd() {
        memoizationEnds += 1;
      }
    };
    const fn = new Inngest({
      id: testClientId,
      middleware: [counting],
    }).createFunction(
      { id: "looks-like", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        return step.run("a", () => {
          return `${subscriptionMessagePrefix}looks-like-a-message`;
        });
      },
    );

    const first = await runFnWithStack(
      fn,
      {},
      { event: { name: "sub/run", data: {} } },
    );
    if (first.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${first.type}`);
    }

    const second = await runFnWithStack(
      fn,
      {
        [first.step.id]: { id: first.step.id, data: first.step.data },
      },
      { event: { name: "sub/run", data: {} } },
    );

    expect(second.type).toBe("function-resolved");
    expect(memoizationEnds).toBeGreaterThan(0);
  });
});
