/*
 * This test file is for Durable Endpoints that do not go into async mode and do
 * not stream.
 */

import { testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { step } from "../../../index.ts";

import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("return Response object", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    return Response.json("All done", { status: 202 });
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);
  expect(res.status).toBe(202);
  expect(await res.json()).toBe("All done");
});

test("return string", async () => {
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
