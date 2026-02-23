import { expect, test } from "vitest";
import { z } from "zod/v3";
// Relative import from sibling package; types mismatch with local inngest
// source (two separate declarations of Inngest.Any) but are structurally
// identical at runtime. @ts-expect-error comments below silence the nominal
// type incompatibility.
import {
  EncryptionService,
  encryptionMiddleware,
  isEncryptedValue,
} from "../../../../../../middleware-encryption/src/middleware.ts";
import { Inngest, invoke } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  createState,
  fetchEvent,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);
const encryptionKey = "test-encryption-key-that-is-long-enough";

test("step.run output is encrypted on the wire and decrypted in function", async () => {
  const state = createState({
    stepOutputs: [] as { message: string; count: number }[],
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    // @ts-expect-error - cross-package nominal type mismatch
    middleware: [encryptionMiddleware({ key: encryptionKey })],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;

      const output = await step.run("my-step", () => {
        return { message: "hello", count: 42 };
      });

      state.stepOutputs.push(output);
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // The user sees decrypted data inside the function
  expect(state.stepOutputs).toEqual([{ message: "hello", count: 42 }]);
});

test("step.invoke data is encrypted on the wire", async () => {
  // Parent invokes child with encrypted event data. The child function
  // receives decrypted event data and returns it. The parent receives the
  // decrypted result from step.invoke.

  const state = createState({
    childEventData: null as Record<string, unknown> | null,
    childEventsData: [] as Record<string, unknown>[],
    invokeOutput: null as Record<string, unknown> | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    // @ts-expect-error - cross-package nominal type mismatch
    middleware: [encryptionMiddleware({ key: encryptionKey })],
  });

  const parentFn = client.createFunction(
    { id: "parent-fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;

      const output = await step.invoke("invoke-child", {
        data: {
          [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
            secret: "sensitive-data",
          },
          public_field: "visible",
        },
        function: childFn,
      });

      state.invokeOutput = output as Record<string, unknown>;
    },
  );

  const childFn = client.createFunction(
    {
      id: "child-fn",
      retries: 0,
      triggers: [
        invoke(
          z.object({
            encrypted: z.record(z.unknown()),
            public_field: z.string(),
          }),
        ),
      ],
    },
    async ({ event, events }) => {
      state.childEventData = event.data;
      state.childEventsData = events.map((e) => e.data);

      return event.data;
    },
  );

  await createTestApp({ client, functions: [parentFn, childFn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Child function receives decrypted event data
  await waitFor(() => {
    expect(state.childEventData).not.toBeNull();
  });

  expect(state.childEventData).toEqual(
    expect.objectContaining({
      [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
        secret: "sensitive-data",
      },
      public_field: "visible",
    }),
  );

  // Parent receives decrypted invoke output
  expect(state.invokeOutput).toEqual(
    expect.objectContaining({
      [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
        secret: "sensitive-data",
      },
      public_field: "visible",
    }),
  );
});

describe("outgoing event data is encrypted on the wire", () => {
  test("client.send", async () => {
    // Send an event with an encrypted field. Verify the field is encrypted on
    // the Dev Server but decrypted inside the function handler.

    const state = createState({
      eventData: null as Record<string, unknown> | null,
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      // @ts-expect-error - cross-package nominal type mismatch
      middleware: [encryptionMiddleware({ key: encryptionKey })],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ event, runId }) => {
        state.runId = runId;
        state.eventData = event.data;
      },
    );

    await createTestApp({ client, functions: [fn] });

    const { ids } = await client.send({
      name: eventName,
      data: {
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
          secret: "sensitive",
        },
        public_field: "visible",
      },
    });
    await state.waitForRunComplete();

    // Encrypted on the Dev Server
    const eventFromDevServer = await fetchEvent(ids[0]!);
    expect(eventFromDevServer.data.public_field).toBe("visible");
    expect(
      isEncryptedValue(
        eventFromDevServer.data[
          EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD
        ],
      ),
    ).toBe(true);

    // Decrypted within the function handler
    expect(state.eventData).toEqual(
      expect.objectContaining({
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
          secret: "sensitive",
        },
        public_field: "visible",
      }),
    );
  });

  test("step.sendEvent", async () => {
    // Send an event via step.sendEvent with an encrypted field. Verify the
    // field is encrypted on the Dev Server but decrypted in the child
    // function handler.

    const state = createState({
      childEventData: null as Record<string, unknown> | null,
      childEventId: null as string | null,
    });

    const parentEventName = randomSuffix("evt");
    const childEventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      // @ts-expect-error - cross-package nominal type mismatch
      middleware: [encryptionMiddleware({ key: encryptionKey })],
    });

    const parentFn = client.createFunction(
      { id: "parent", retries: 0, triggers: [{ event: parentEventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        const { ids } = await step.sendEvent("send-it", {
          name: childEventName,
          data: {
            [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
              secret: "sensitive",
            },
            public_field: "visible",
          },
        });
        state.childEventId = ids[0]!;
      },
    );

    const childFn = client.createFunction(
      { id: "child", retries: 0, triggers: [{ event: childEventName }] },
      async ({ event, runId }) => {
        state.runId = runId;
        state.childEventData = event.data;
      },
    );

    await createTestApp({ client, functions: [parentFn, childFn] });

    await client.send({ name: parentEventName });
    await state.waitForRunComplete();

    // Wait for child to process
    await waitFor(() => {
      expect(state.childEventData).not.toBeNull();
    });

    // Encrypted on the Dev Server
    const eventFromDevServer = await fetchEvent(state.childEventId!);
    expect(eventFromDevServer.data.public_field).toBe("visible");
    expect(
      isEncryptedValue(
        eventFromDevServer.data[
          EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD
        ],
      ),
    ).toBe(true);

    // Decrypted within the child function handler
    expect(state.childEventData).toEqual(
      expect.objectContaining({
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
          secret: "sensitive",
        },
        public_field: "visible",
      }),
    );
  });
});
