import {
  createState,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { ConnectionState, connect } from "../../../connect.ts";
import { ConsoleLogger, Inngest } from "../../../index.ts";
import {
  ConnectMessage,
  GatewayMessageType,
} from "../../../proto/src/components/connect/protobuf/connect.ts";
import { WebSocketProxy } from "../proxy.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("shutdown + connection drop: reconnects with WORKER_PAUSE instead of WORKER_READY", async () => {
  let proxy = new WebSocketProxy();
  await proxy.start();
  // Capture the port so we can restart on the same one.
  const proxyUrl = proxy.url;
  const port = new URL(proxyUrl.replace("ws://", "http://")).port;

  onTestFinished(async () => {
    await proxy.stop();
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    logger: new ConsoleLogger({ level: "error" }),
  });

  const state = createState();

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
      await sleep(10_000);
      return "done";
    },
  );

  const connection = await connect({
    apps: [{ client, functions: [fn] }],
    gatewayUrl: `${proxyUrl}/v0/connect`,
  });
  onTestFinished(async () => {
    await connection.close();
  });
  await waitFor(() => {
    expect(connection.state).toBe(ConnectionState.ACTIVE);
  });

  await client.send({ name: eventName });
  await state.waitForRunId();

  // Initiate graceful shutdown while a request is in-flight.
  const closePromise = connection.close();
  await waitFor(() => {
    expect(connection.state).toBe(ConnectionState.CLOSING);
  });

  // Drop the TCP connection to simulate gateway going away during a rollout.
  await proxy.stop();

  // Restart on the same port so the SDK's gatewayUrl still works.
  proxy = new WebSocketProxy();
  await proxy.listen(Number(port));

  // Wait for the function to finish — proves lease extensions survived.
  await closePromise;
  const result = await state.waitForRunComplete();
  expect(result).toBe("done");

  // After reconnecting during shutdown, only WORKER_PAUSE should be sent
  // (not WORKER_READY) so no new work is routed to a dying worker.
  const sentKinds = proxy.forwardedClientMessages
    .map((raw) => {
      try {
        return ConnectMessage.decode(raw).kind;
      } catch {
        return null;
      }
    })
    .filter((k) => k !== null);

  expect(sentKinds).not.toContain(GatewayMessageType.WORKER_READY);
  expect(sentKinds).toContain(GatewayMessageType.WORKER_PAUSE);
}, 30_000);
