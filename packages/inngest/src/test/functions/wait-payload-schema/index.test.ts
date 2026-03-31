import { createState } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { eventRunWithName, sendEvent } from "../../helpers";

const name = "wait-payload-schema";

test("valid data", async () => {
  const state = createState({});
  const eventId = await sendEvent(name);
  state.runId = await eventRunWithName(eventId, name);
  await sendEvent(`${name}/resolve`, { nested: { msg: "hello" } });

  const output = await state.waitForRunComplete();
  expect(output).toEqual({ nested: { msg: "hello" } });
}, 60_000);

test("invalid data", async () => {
  const state = createState({});
  const eventId = await sendEvent(name);
  state.runId = await eventRunWithName(eventId, name);
  await sendEvent(`${name}/resolve`, { nested: { msg: 123 } });

  const error = await state.waitForRunFailed();
  expect(error).toMatchObject({
    message: "nested.msg: Expected string, received number",
  });
}, 60_000);
