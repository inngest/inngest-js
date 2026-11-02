/**
 * @module
 * The tour's Dev Server retries a failed step after about a second, not after
 * the Dev Server's default backoff. Runs the real binary against a small app.
 * Skipped when the Dev Server binary is not built.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { freePort, resolveBinary } from "../scripts/lib.ts";
import { DevServer } from "../server/devserver.ts";

const binary = resolveBinary();

describe("Dev Server retries", { skip: binary === undefined }, () => {
  const attempts: number[] = [];
  let server: Server;
  let devServer: DevServer;

  before(async () => {
    if (!binary) {
      return;
    }

    const api = await freePort();
    const client = new Inngest({
      id: "retry-test",
      isDev: true,
      baseUrl: `http://127.0.0.1:${api}`,
    });

    const flaky = client.createFunction(
      { id: "flaky", retries: 2, triggers: [{ event: "retry/start" }] },
      async () => {
        attempts.push(Date.now());

        if (attempts.length === 1) {
          throw new Error("fails once");
        }

        return "ok";
      },
    );
    const handler = serve({ client, functions: [flaky] });
    const appPort = await freePort();

    server = createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(appPort, "127.0.0.1", resolve);
    });

    devServer = new DevServer({
      binary,
      ports: {
        api,
        gateway: await freePort(),
        gatewayGrpc: await freePort(),
        executorGrpc: await freePort(),
      },
      appUrl: `http://127.0.0.1:${appPort}/api/inngest`,
      logFile: `${process.env.TMPDIR ?? "/tmp"}/tour-retry-test-${appPort}.log`,
    });
    await devServer.start();
  });

  after(async () => {
    await devServer.stop();

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("retries a failed step after about a second", async () => {
    await devServer.send("retry/start", {});

    const end = Date.now() + 20_000;

    while (attempts.length < 2 && Date.now() < end) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    assert.equal(attempts.length, 2, "the step was not retried in 20s");

    const gap = attempts[1] - attempts[0];

    assert.ok(gap < 3000, `the retry came ${gap}ms after the failure`);
  });
});
