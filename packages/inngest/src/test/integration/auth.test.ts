import type { AddressInfo } from "node:net";
import { randomSuffix, testNameFromFileUrl } from "@inngest/test-harness";
import { afterEach, expect, test } from "vitest";
import { headerKeys } from "../../helpers/consts.ts";
import { signWithHashJs } from "../../helpers/net.ts";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const signingKey = "signkey-test-1234567890";

const testFileName = testNameFromFileUrl(import.meta.url);

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/**
 * Start a server in cloud mode (isDev: false) with a signing key configured,
 * then return the URL. This bypasses the no-signing-key 500 path so we can
 * exercise the body and signature checks.
 */
async function startCloudServer(): Promise<string> {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: false,
    eventKey: "event-key-123",
    signingKey,
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: "test/event" }] },
    async () => "ok",
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

describe("GET", () => {
  test("correct signature", async () => {
    const url = await startCloudServer();

    // GETs sign over an empty body.
    const ts = Math.round(Date.now() / 1000).toString();
    const sig = `t=${ts}&s=${signWithHashJs("", signingKey, ts)}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        [headerKeys.Signature]: sig,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authentication_succeeded: true,
      mode: "cloud",
    });
    expect(getInngestHeaders(res.headers)).toEqual({
      'x-inngest-framework': 'nodejs',
      'x-inngest-req-version': '2',
      'x-inngest-sdk': expect.any(String),
      'x-inngest-sdk-handled': 'true',
      'x-inngest-signature': expect.any(String),
    });
  });

test("no signature", async () => {
  const url = await startCloudServer();

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ message: "Unauthorized" });
  expect(getInngestHeaders(res.headers)).toEqual({
    [headerKeys.SdkHandled]: "true",
  });
});
});

describe("POST", () => {
  test("no body", async () => {
    const url = await startCloudServer();

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
    expect(getInngestHeaders(res.headers)).toEqual({
      [headerKeys.SdkHandled]: "true",
    });
  });

  test("no signature", async () => {
    const url = await startCloudServer();

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
    expect(getInngestHeaders(res.headers)).toEqual({
      [headerKeys.SdkHandled]: "true",
    });
  });

  test("incorrect signature", async () => {
    const url = await startCloudServer();

    // Well-formed but wrong: current timestamp (so it doesn't trip the
    // expiry check) paired with an HMAC that doesn't match the body.
    const ts = Math.round(Date.now() / 1000);
    const badSig = `t=${ts}&s=${"0".repeat(64)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [headerKeys.Signature]: badSig,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
    expect(getInngestHeaders(res.headers)).toEqual({
      [headerKeys.SdkHandled]: "true",
    });
  });
});

test("PATCH with no signature", async () => {
  const url = await startCloudServer();

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(405);
  expect(await res.json()).toEqual({ message: "Method not allowed" });
  expect(getInngestHeaders(res.headers)).toEqual({
    [headerKeys.SdkHandled]: "true",
  });
});


function getInngestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith("x-inngest-")) {
      out[k] = v;
    }
  });
  return out;
}