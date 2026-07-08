import type { AddressInfo } from "node:net";
import { randomSuffix, testNameFromFileUrl } from "@inngest/test-harness";
import { afterEach, expect, test } from "vitest";
import { createDefer } from "../../experimental.ts";
import { headerKeys } from "../../helpers/consts.ts";
import { Inngest, NonRetriableError, RetryAfterError } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);
const eventName = "test/event";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function startApp(
  client: Inngest.Any,
  functions: Parameters<typeof createServer>[0]["functions"],
): Promise<string> {
  const servePath = "/api/inngest";
  const server = createServer({ client, functions, servePath });
  cleanup = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

  return `http://localhost:${port}${servePath}`;
}

async function startServerWithStepThatThrows(
  err: Error,
): Promise<{ url: string; fnId: string }> {
  const appId = randomSuffix(testFileName);

  const client = new Inngest({ id: appId, isDev: true });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step }) => {
      await step.run("test-step", () => {
        throw err;
      });
    },
  );

  const url = await startApp(client, [fn]);
  return { url, fnId: `${appId}-fn` };
}

async function startServerWithDeferThatThrows(
  err: Error,
): Promise<{ url: string; fnId: string }> {
  const appId = randomSuffix(testFileName);

  const client = new Inngest({ id: appId, isDev: true });
  const target = createDefer(client, { id: "target" }, async () => {});
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ defer }) => {
      defer("x", { function: target, data: {} });
      throw err;
    },
  );

  const url = await startApp(client, [fn, target]);
  return { url, fnId: `${appId}-fn` };
}

function stepExecBody() {
  return {
    ctx: {
      run_id: "run-1",
      attempt: 0,
      disable_immediate_execution: false,
      use_api: false,
      stack: { stack: [], current: 0 },
    },
    event: { name: eventName, data: {} },
    events: [{ name: eventName, data: {} }],
    steps: {},
  };
}

test("RetryAfterError thrown inside step.run sets Retry-After header", async () => {
  const { url, fnId } = await startServerWithStepThatThrows(
    new RetryAfterError("rate limited", 600_000),
  );

  const res = await fetch(`${url}?fnId=${fnId}&stepId=step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stepExecBody()),
  });

  expect(res.status).toBe(206);
  expect(res.headers.get(headerKeys.RetryAfter)).toBe("600");
  expect(res.headers.get(headerKeys.NoRetry)).toBe("false");
});

test("NonRetriableError thrown inside step.run sets X-Inngest-No-Retry header", async () => {
  const { url, fnId } = await startServerWithStepThatThrows(
    new NonRetriableError("permanent failure"),
  );

  const res = await fetch(`${url}?fnId=${fnId}&stepId=step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stepExecBody()),
  });

  expect(res.status).toBe(206);
  expect(res.headers.get(headerKeys.NoRetry)).toBe("true");
  expect(res.headers.get(headerKeys.RetryAfter)).toBeNull();
});

test("RetryAfterError with a buffered defer ships RunError with only a Retry-After header", async () => {
  const { url, fnId } = await startServerWithDeferThatThrows(
    new RetryAfterError("rate limited", 600_000),
  );

  const res = await fetch(`${url}?fnId=${fnId}&stepId=step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stepExecBody()),
  });

  expect(res.status).toBe(206);
  expect(res.headers.get(headerKeys.RetryAfter)).toBe("600");
  // Never set on a RunError 206: the header decides retryability at the
  // transport level and would override the executor's in-band decision.
  expect(res.headers.get(headerKeys.NoRetry)).toBeNull();

  const ops = await res.json();
  expect(ops).toContainEqual(expect.objectContaining({ op: "DeferAdd" }));
  expect(ops).toContainEqual(
    expect.objectContaining({
      op: "RunError",
      error: expect.objectContaining({ name: "RetryAfterError" }),
    }),
  );
  expect(ops).not.toContainEqual(
    expect.objectContaining({
      error: expect.objectContaining({ noRetry: true }),
    }),
  );
});

test("NonRetriableError with a buffered defer ships RunError with in-band noRetry and no retry headers", async () => {
  const { url, fnId } = await startServerWithDeferThatThrows(
    new NonRetriableError("permanent failure"),
  );

  const res = await fetch(`${url}?fnId=${fnId}&stepId=step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stepExecBody()),
  });

  expect(res.status).toBe(206);
  expect(res.headers.get(headerKeys.NoRetry)).toBeNull();
  expect(res.headers.get(headerKeys.RetryAfter)).toBeNull();

  const ops = await res.json();
  expect(ops).toContainEqual(expect.objectContaining({ op: "DeferAdd" }));
  expect(ops).toContainEqual(
    expect.objectContaining({
      op: "RunError",
      error: expect.objectContaining({
        name: "NonRetriableError",
        noRetry: true,
      }),
    }),
  );
});
