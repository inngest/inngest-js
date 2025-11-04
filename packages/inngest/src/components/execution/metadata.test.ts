import { describe, expect, test } from "vitest";

import { createClient, runFnWithStack, testClientId } from "../../test/helpers.ts";

describe("execution metadata propagation", () => {
  test("step metadata is attached to step-ran results", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-step" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update({ run: "outer" });
        return await step.run("step", async () => {
          await step.metadata.update({ step: "inner" });
          return "done";
        });
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "step-ran",
      metadata: { run: "outer" },
      step: expect.objectContaining({
        metadata: { step: "inner" },
        data: "done",
      }),
    });
  });

  test("run metadata is attached to function results", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-run" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update({ run: "outer" });
        return "ok";
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "function-resolved",
      data: "ok",
      metadata: { run: "outer" },
    });
  });

  test("step metadata merges shallowly", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-step-merge" },
      { event: "test/event" },
      async ({ step }) => {
        return await step.run("step", async () => {
          await step.metadata.update({ foo: "first", nested: { keep: true } });
          await step.metadata.update({ foo: "second" });
          return null;
        });
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "step-ran",
      step: expect.objectContaining({
        metadata: { foo: "second", nested: { keep: true } },
      }),
    });
  });

  test("run metadata merges shallowly", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-run-merge" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update({ foo: "first", nested: { keep: true } });
        await step.metadata.update({ foo: "second" });
        return null;
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "function-resolved",
      metadata: { foo: "second", nested: { keep: true } },
    });
  });

  test("run metadata is attached to function-rejected results", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-run-error" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update({ run: "outer" });
        throw new Error("boom");
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "function-rejected",
      metadata: { run: "outer" },
    });
  });

  test("run metadata is attached to steps-found results", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-steps-found" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update({ run: "outer" });

        await step.run("step", async () => {
          await step.metadata.update({ step: "inner" });
          return "done";
        });
      },
    );

    const res = await runFnWithStack(fn, {}, { disableImmediateExecution: true });

    expect(res).toMatchObject({
      type: "steps-found",
      metadata: { run: "outer" },
    });
  });

  test("step metadata namespaces identifiers", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-step-id" },
      { event: "test/event" },
      async ({ step }) => {
        return await step.run("step", async () => {
          await step.metadata.update("progress", { value: 1 });
          await step.metadata.update("progress", { value: 2 });
          return null;
        });
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "step-ran",
      step: expect.objectContaining({
        metadata: { progress: { value: 2 } },
      }),
    });
  });

  test("run metadata namespaces identifiers", async () => {
    const client = createClient({ id: testClientId });
    const fn = client.createFunction(
      { id: "metadata-run-id" },
      { event: "test/event" },
      async ({ step }) => {
        await step.metadata.update("progress", { value: 1 });
        await step.metadata.update("progress", { value: 2 });
        return null;
      },
    );

    const res = await runFnWithStack(fn, {});

    expect(res).toMatchObject({
      type: "function-resolved",
      metadata: { progress: { value: 2 } },
    });
  });
});


