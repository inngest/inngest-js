import type { AddressInfo } from "node:net";
import { randomSuffix, testNameFromFileUrl } from "@inngest/test-harness";
import { afterEach, expect, test } from "vitest";
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

async function startServerWithStepThatThrows(
  err: Error,
): Promise<{ url: string; fnId: string }> {
  const appId = randomSuffix(testFileName);
  const fnInternalId = "fn";

  const client = new Inngest({ id: appId, isDev: true });
  const fn = client.createFunction(
    { id: fnInternalId, retries: 0, triggers: [{ event: eventName }] },
    async ({ step }) => {
      await step.run("test-step", () => {
        throw err;
      });
    },
  );

  const servePath = "/api/inngest";
  const server = createServer({ client, functions: [fn], servePath });
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

  return {
    url: `http://localhost:${port}${servePath}`,
    fnId: `${appId}-${fnInternalId}`,
  };
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
