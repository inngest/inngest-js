import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createState,
  randomSuffix,
  registerApp,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An HTTP proxy that forwards every request to an upstream port but returns a
 * 504 on the first request after 10 seconds. Simulates an edge proxy (e.g.
 * nginx) timing out before the SDK can respond.
 */
function createGatewayTimeoutProxy(getUpstreamPort: () => number): http.Server {
  let count = 0;
  return http.createServer((clientReq, clientRes) => {
    count++;
    const should504 = count === 0;
    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: getUpstreamPort(),
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
    });

    clientReq.pipe(proxyReq);

    proxyReq.on("response", (upstreamRes) => {
      if (should504) {
        // Drain without forwarding. Timeout response will be sent instead.
        upstreamRes.resume();
      } else {
        clientRes.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    });
    proxyReq.on("error", () => {
      // The upstream may already be torn down; ignore.
    });

    if (should504) {
      console.log("will timeout");
      setTimeout(() => {
        console.log("timing out");
        clientRes.writeHead(504, { "Content-Type": "text/plain" });
        clientRes.end("Gateway Timeout");
      }, 10_000);
    }
  });
}

test("interrupt control flow when dispatch validation fails", async () => {
  // This test replicates a scenario where a proxy HTTP timeout causes 2
  // execution requests to process at the same time, where the first one is a
  // "zombie" (the proxy already sent a 504 response). If we don't interrupt,
  // then we risk duplicate execution in steps. This is exacerbated by multiple
  // sequential HTTP timeouts, since that would lead to many simultaneous
  // requests executing the same steps in each.
  //
  // In this situation, the Inngest Server tells the SDK that it needs to
  // interrupt via a 409 response to the outgoing checkpoint request.

  const state = createState({
    stepCounts: {
      a: 0,
      b: 0,
      c: 0,
      d: 0,
    },
  });

  let appPort = 0;
  const proxyServer = createGatewayTimeoutProxy(() => appPort);
  await new Promise<void>((resolve) =>
    proxyServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const proxyPort = (proxyServer.address() as AddressInfo).port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  onTestFinished(
    () => new Promise<void>((resolve) => proxyServer.close(() => resolve())),
  );

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 1,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("", async () => {
        state.stepCounts.a++;

        // Wait longer than the 504 timeout, ensuring that the outgoing
        // checkpoint request sends after the 2nd execution request arrives.
        // This results in a dispatch validation error in the checkpoint
        // endpoint handler.
        await sleep(11_000);
      });
      await step.run("b", async () => {
        state.stepCounts.b++;
      });
      await step.run("c", async () => {
        state.stepCounts.c++;
      });
      await step.run("d", async () => {
        state.stepCounts.d++;
      });
    },
  );

  const servePath = "/api/inngest";
  const appServer = createServer({
    client,
    functions: [fn],
    servePath,
    // The dev server learns the proxy URL as the invocation origin, so
    // future invokes traverse the proxy and receive 504s.
    serveOrigin: proxyUrl,
  });
  await new Promise<void>((resolve) =>
    appServer.listen(0, "127.0.0.1", () => resolve()),
  );
  appPort = (appServer.address() as AddressInfo).port;
  onTestFinished(
    () => new Promise<void>((resolve) => appServer.close(() => resolve())),
  );

  // Register directly with the app (bypassing the proxy) so registration
  // succeeds; the body advertises the proxy URL via `serveOrigin`.
  await registerApp(`http://127.0.0.1:${appPort}${servePath}`);

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.stepCounts).toEqual({
    a: 1,
    b: 1,
    c: 1,
    d: 1,
  });
}, 60_000);
