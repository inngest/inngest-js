/**
 * @module
 * Tests for reading subscription messages out of a run's state.
 */
import {
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
