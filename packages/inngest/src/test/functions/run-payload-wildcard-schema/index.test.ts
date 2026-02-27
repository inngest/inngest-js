import { createState } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { eventRunWithName, sendEvent } from "../../helpers";

const name = "run-payload-wildcard-schema";

test("valid data", async () => {
  const state = createState({});
  const eventId = await sendEvent(`${name}/foo`, { nested: { msg: "hello" } });
  state.runId = await eventRunWithName(eventId, name);

  const output = await state.waitForRunComplete();
  expect(output).toEqual({ nested: { msg: "hello" } });
}, 60_000);

test("invalid data", async () => {
  const state = createState({});
  const eventId = await sendEvent(`${name}/foo`, { nested: { msg: 123 } });
  state.runId = await eventRunWithName(eventId, name);

  const error = await state.waitForRunFailed();
  expect(error).toMatchObject({
    message: "nested.msg: Expected string, received number",
  });
}, 60_000);
