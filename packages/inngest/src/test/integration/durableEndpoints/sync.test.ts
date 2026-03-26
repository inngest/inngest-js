/*
 * This test file is for Durable Endpoints that:
 * - Do not go into async mode
 * - Do not stream
 */

import { testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { NonRetriableError, step } from "../../../index.ts";

import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("stepless endpoint", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    return Response.json("no steps here");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(200);
  expect(await res.json()).toBe("no steps here");
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("return Response object", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    return Response.json("All done", { status: 202 });
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(202);
  expect(await res.json()).toBe("All done");
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("return string", async () => {
  const { port } = await setupEndpoint(
    testFileName,
    // @ts-expect-error - Static types aren't happy but it works at runtime
    async () => {
      await step.run("a", async () => {});
      return "All done";
    },
  );

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(200);
  expect(await res.json()).toBe("All done");
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("multiple steps returning different types", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    const num = await step.run("number-step", async () => 42);
    const obj = await step.run("object-step", async () => ({
      key: "value",
    }));
    const arr = await step.run("array-step", async () => [1, 2, 3]);
    return Response.json({ num, obj, arr });
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    num: 42,
    obj: { key: "value" },
    arr: [1, 2, 3],
  });
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("NonRetriableError in a step", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("will-fail", async () => {
      throw new NonRetriableError("fatal");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("NonRetriableError");
  expect(body.message).toBe("fatal");
});
