/*
 * This test file is for Durable Endpoints that:
 * - Go into async mode (e.g. step.sleep)
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
    const a = await step.run("a", async () => "hello");
    await step.sleep("go-async", "1s");
    const b = await step.run("b", async () => "world");
    return Response.json(`${a} ${b}`, { status: 202 });
  });

  let res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();
  state.runId = await waitForRunId();

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  // FIXME: The output is enveloped in an Inngest-specific object. This is a bug
  // we'll fix in https://linear.app/inngest/issue/EXE-1527
  expect((await res.json()).data.body).toBe('"\\"hello world\\""');

  await state.waitForRunComplete();
});

test("return string", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(
    testFileName,
    // @ts-expect-error - Static types aren't happy but it works at runtime
    async () => {
      const a = await step.run("a", async () => "hello");
      await step.sleep("go-async", "1s");
      const b = await step.run("b", async () => "world");
      return `${a} ${b}`;
    },
  );

  let res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();
  state.runId = await waitForRunId();

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  // FIXME: The output is enveloped in an Inngest-specific object. This is a bug
  // we'll fix in https://linear.app/inngest/issue/EXE-1527
  expect((await res.json()).data.body).toBe('"hello world"');

  await state.waitForRunComplete();
});
