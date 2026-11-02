/**
 * @module
 * Type tests: an inbox message is a union by event `name`.
 */
import type { ThreadInboxMessage } from "../agent/types.ts";

describe("thread message events", () => {
  // Never called: the test is the types.
  const types = (message: ThreadInboxMessage) => {
    switch (message.name) {
      case "agent/steer":
      case "agent/message":
        expectTypeOf(message.data.text).toBeString();

        // @ts-expect-error only a stop has a when
        message.data.when;
        break;
      default:
        break;
    }
  };

  test("each event has its own data", () => {
    expect(types).toBeTypeOf("function");
  });
});
