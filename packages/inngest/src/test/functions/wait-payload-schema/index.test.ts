import { expect, test } from "vitest";
import { eventRunWithName, runHasTimeline, sendEvent } from "../../helpers";

const name = "wait-payload-schema";

test("valid data", async () => {
  const eventId = await sendEvent(name);
  const runId = await eventRunWithName(eventId, name);
  await sendEvent(`${name}/resolve`, { nested: { msg: "hello" } });

  const item = await runHasTimeline(runId, {
    stepType: "FINALIZATION",
    status: "COMPLETED",
  });
  expect(item).toBeDefined();
  const output = await item?.getOutput();
  expect(output).toEqual({ data: { nested: { msg: "hello" } } });
});

test("invalid data", async () => {
  const eventId = await sendEvent(name);
  const runId = await eventRunWithName(eventId, name);
  await sendEvent(`${name}/resolve`, { nested: { msg: 123 } });

  const item = await runHasTimeline(runId, {
    stepType: "FINALIZATION",
   status: "FAILED",
  });
  const { error } = await item?.getOutput();
  expect(error.message).toEqual("nested.msg: Expected string, received number");
  expect(error.stack).toMatch(
    /EventValidationError: nested.msg: Expected string, received number/,
  );
}, 10_000);
