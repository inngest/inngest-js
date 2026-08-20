import type { AddressInfo } from "node:net";
import { randomSuffix, testNameFromFileUrl } from "@inngest/test-harness";
import { afterEach, expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * Start a server in cloud mode (isDev: false) with no signing key, then return
 * the URL. This deliberately skips Dev Server registration.
 */
async function startCloudServerWithoutSigningKey(): Promise<string> {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: false,
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: "test/event" }] },
    async () => {
      return "ok";
    },
  );

  const servePath = "/api/inngest";
  const server = createServer({
    client,
    functions: [fn],
    servePath,
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

  cleanup = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return `http://localhost:${port}${servePath}`;
}

test("serve() does not throw without a signing key in cloud mode", async () => {
  // This should not throw — the error is deferred to request time.
  const url = await startCloudServerWithoutSigningKey();
  expect(url).toBeDefined();
});

test("GET returns 500 without a signing key in cloud mode", async () => {
  const url = await startCloudServerWithoutSigningKey();

  const res = await fetch(url);

  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ code: "internal_server_error" });
});

test("POST returns 500 without a signing key in cloud mode", async () => {
  const url = await startCloudServerWithoutSigningKey();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ code: "internal_server_error" });
});

test("PUT returns 500 without a signing key in cloud mode", async () => {
  const url = await startCloudServerWithoutSigningKey();

  const res = await fetch(url, { method: "PUT" });

  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ code: "internal_server_error" });
});
