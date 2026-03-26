/*
 * This test file is for Durable Endpoints that:
 * - Go into async mode (e.g. step.sleep)
 * - Do not stream
 */

import { testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { NonRetriableError, step } from "../../../index.ts";

import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("return Response object", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    const a = await step.run("a", async () => "hello");
    await step.sleep("go-async", "1s");
    const b = await step.run("b", async () => "world");
    return Response.json(`${a} ${b}`, { status: 202 });
  });

  let res = await fetch(`http://localhost:${port}/api/demo`, {
    redirect: "manual",
  });

  // Ensure there's a redirect
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  expect((await res.json()).data.body).toBe('"hello world"');
});

test("return string", async () => {
  const { port } = await setupEndpoint(
    testFileName,
    // @ts-expect-error - Static types aren't happy but it works at runtime
    async () => {
      const a = await step.run("a", async () => "hello");
      await step.sleep("go-async", "1s");
      const b = await step.run("b", async () => "world");
      return `${a} ${b}`;
    },
  );

  let res = await fetch(`http://localhost:${port}/api/demo`, {
    redirect: "manual",
  });

  // Ensure there's a redirect
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  // FIXME: The output is enveloped in an Inngest-specific object. This is a bug
  // we'll fix in https://linear.app/inngest/issue/EXE-1527
  expect((await res.json()).data.body).toBe('"hello world"');
});

test("multiple async transitions", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    const a = await step.run("a", async () => "first");
    await step.sleep("sleep-1", "1s");
    const b = await step.run("b", async () => "second");
    await step.sleep("sleep-2", "1s");
    const c = await step.run("c", async () => "third");
    return Response.json(`${a} ${b} ${c}`);
  });

  let res = await fetch(`http://localhost:${port}/api/demo`, {
    redirect: "manual",
  });
  expect(res.status).toBe(302);

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  expect((await res.json()).data.body).toBe('"first second third"');
});

test("NonRetriableError after async transition", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => "ok");
    await step.sleep("go-async", "1s");
    await step.run("will-fail", async () => {
      throw new NonRetriableError("fatal after async");
    });
    return Response.json("unreachable");
  });

  let res = await fetch(`http://localhost:${port}/api/demo`, {
    redirect: "manual",
  });

  // First response is a redirect (async mode kicks in after step.sleep)
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();

  res = await fetch(res.headers.get("location")!);
  expect(res.status).toBe(200);

  // The run should have failed — error is serialized directly in the response
  const body = await res.json();
  expect(body.name).toBe("NonRetriableError");
  expect(body.message).toBe("fatal after async");
});
