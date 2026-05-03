/*
 * This test file is for Durable Endpoints that:
 * - Do not go into async mode
 * - Do not stream
 */

import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { step } from "../../../index.ts";

import { setupEndpoint, urlWithTestName } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("return Response object", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    return Response.json("All done", { status: 202 });
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`));
  expect(res.status).toBe(202);
  expect(await res.json()).toBe("All done");

  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("return string", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(
    testFileName,
    // @ts-expect-error - Static types aren't happy but it works at runtime
    async () => {
      await step.run("a", async () => {});
      return "All done";
    },
  );

  const res = await fetch(urlWithTestName(`http://localhost:${port}`));
  expect(res.status).toBe(200);
  expect(await res.json()).toBe("All done");

  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});
