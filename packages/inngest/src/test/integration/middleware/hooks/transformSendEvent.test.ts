import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  createState,
  fetchEvent,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";
import { matrixLevel } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixLevel("transform event data before sending", async (level) => {
  const state = createState({ eventId: "" });

  const eventName = randomSuffix("evt");

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      if (arg.events[0]?.name === eventName) {
        // Ignore the test-triggering event
        return arg;
      }

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

  let clientMiddleware: Middleware.Class[] = [];
  let functionMiddleware: Middleware.Class[] = [];
  if (level === "client") {
    clientMiddleware = [TestMiddleware];
  } else {
    functionMiddleware = [TestMiddleware];
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: clientMiddleware,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      middleware: functionMiddleware,
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ runId, step }) => {
      state.runId = runId;

      const { ids } = await step.sendEvent("send", {
        name: randomSuffix("sendEvent"),
        data: { original: "data" },
      });
      state.eventId = ids[0]!;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  const event = await fetchEvent(state.eventId);

  expect(event.data).toEqual({
    injected: "value",
    original: "data",
  });
});

matrixLevel("multiple middleware transform in order", async (level) => {
  const state = createState({ eventId: "" });

  const eventName = randomSuffix("evt");

  class Mw1 extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      if (arg.events[0]?.name === eventName) {
        // Ignore the test-triggering event
        return arg;
      }

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
      if (arg.events[0]?.name === eventName) {
        // Ignore the test-triggering event
        return arg;
      }

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

  let clientMiddleware: Middleware.Class[] = [];
  let functionMiddleware: Middleware.Class[] = [];
  if (level === "client") {
    clientMiddleware = [Mw1, Mw2];
  } else {
    functionMiddleware = [Mw1, Mw2];
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ runId, step }) => {
      state.runId = runId;
      const { ids } = await step.sendEvent("send", {
        name: randomSuffix("sendEvent"),
        data: { original: "data" },
      });
      state.eventId = ids[0]!;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  const event = await fetchEvent(state.eventId);

  expect(event.data).toEqual({
    mw1: "first",
    mw2: "second",
    original: "data",
  });
});

test("client.send", async () => {
  // Client-level middleware applies to `client.send`

  const state = createState({
    eventData: null as unknown,
    mwClient: { count: 0 },
    mwFn: { count: 0 },
  });

  class MwClient extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      state.mwClient.count++;
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

  class MwFn extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      // Will not call because function-level middleware only fires for
      // `step.sendEvent`
      state.mwFn.count++;
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MwClient],
  });
  const fn = client.createFunction(
    {
      id: "fn",
      middleware: [MwFn],
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ event, runId }) => {
      state.eventData = event.data;
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  expect(state.eventData).toEqual({
    injected: "value",
    original: "data",
  });
  expect(state.mwClient.count).toBe(1);
  expect(state.mwFn.count).toBe(0);
});

test("function-level stays isolated", async () => {
  // One function's middleware does not affect another function

  const state = createState({
    eventIds: new Set<string>(),
    fnIds: [] as unknown[],
  });

  class Mw extends Middleware.BaseMiddleware {
    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      state.fnIds.push(arg.functionInfo?.id);
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fnWithMw = client.createFunction(
    {
      id: "fn-with-mw",
      middleware: [Mw],
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ step }) => {
      const { ids } = await step.sendEvent("send", {
        data: { fn: "with-mw" },
        name: randomSuffix("sendEvent"),
      });
      state.eventIds.add(ids[0]!);
    },
  );
  const fnWithoutMw = client.createFunction(
    {
      id: "fn-without-mw",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ step }) => {
      const { ids } = await step.sendEvent("send", {
        data: { fn: "without-mw" },
        name: randomSuffix("sendEvent"),
      });
      state.eventIds.add(ids[0]!);
    },
  );
  await createTestApp({ client, functions: [fnWithMw, fnWithoutMw] });

  await client.send({ name: eventName });
  await waitFor(() => {
    expect(state.eventIds.size).toBe(2);
  });

  expect(state.fnIds).toEqual(["fn-with-mw"]);
});
