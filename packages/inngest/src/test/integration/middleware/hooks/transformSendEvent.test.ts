import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("transform event data before sending", async () => {
  const state = createState({
    receivedEventData: null as unknown,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      // Transform the event payloads - add an "injected" field
      return {
        ...arg,
        events: arg.events.map((event) => ({
          ...event,
          data: {
            ...event.data,
            injected: "value",
          },
        })),
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ event, runId }) => {
      state.runId = runId;
      state.receivedEventData = event.data;
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  expect(state.receivedEventData).toEqual({
    injected: "value",
    original: "data",
  });
});

test("multiple middleware transform in order", async () => {
  const state = createState({
    receivedEventData: null as unknown,
  });

  class Mw1 extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      return {
        ...arg,
        events: arg.events.map((event) => ({
          ...event,
          data: {
            ...event.data,
            mw1: "first",
          },
        })),
      };
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      return {
        ...arg,
        events: arg.events.map((event) => ({
          ...event,
          data: {
            ...event.data,
            mw2: "second",
          },
        })),
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ event, runId }) => {
      state.runId = runId;
      state.receivedEventData = event.data;
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  // Both middleware should have transformed the data
  expect(state.receivedEventData).toEqual({
    mw1: "first",
    mw2: "second",
    original: "data",
  });
});
