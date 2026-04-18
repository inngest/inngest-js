import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { Inngest, eventType, staticSchema } from "inngest";
import { createServer } from "inngest/node";
import { expect, expectTypeOf, test } from "vitest";
import { SuperJsonMiddleware } from "../../index";

const testFileName = testNameFromFileUrl(import.meta.url);

test("Date in event data is deserialized as a real Date inside the function", async () => {
  const state = createState({
    eventData: null as {date: Date} | null,
  });

  const myEvent = eventType("test/superjson", {
    schema: staticSchema<{ date: Date }>(),
  });
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SuperJsonMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [myEvent] },
    async ({ event, runId }) => {
      state.runId = runId;

      expectTypeOf(event.data.date).toEqualTypeOf<Date>();
      state.eventData = event.data
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  const data = { date: new Date() };
  await client.send(myEvent.create(data));
  await state.waitForRunComplete();

  expect(state.eventData).toEqual(data);
});
