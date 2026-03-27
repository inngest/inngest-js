import {
  createState,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { ConnectionState, connect } from "../../../connect.ts";
import { Inngest } from "../../../index.ts";
import {
  ConnectMessage,
  GatewayMessageType,
} from "../../../proto/src/components/connect/protobuf/connect.ts";
import { WebSocketProxy } from "../proxy.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

function countMessages(rawMessages: Uint8Array[]) {
  const counts = { heartbeats: 0, leaseExtends: 0 };

  for (const raw of rawMessages) {
    try {
      const msg = ConnectMessage.decode(raw);
      if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
        counts.heartbeats++;
      } else if (msg.kind === GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE) {
        counts.leaseExtends++;
      }
    } catch {
      // Not a valid ConnectMessage — skip.
    }
  }

  return counts;
}

test("graceful shutdown waits for in-flight request with continued heartbeats and lease extensions", async () => {
  // Set up a transparent WebSocket proxy between the SDK and the gateway so
  // we can inspect which messages are sent.
  const proxy = new WebSocketProxy();
  await proxy.start();
  onTestFinished(async () => {
    await proxy.stop();
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const state = createState();

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;

      // Sleep long enough to allow heartbeats and lease extensions to occur.
      await sleep(20_000);

      return "done";
    },
  );

  const connection = await connect({
    apps: [{ client, functions: [fn] }],
    handleShutdownSignals: [],
    isolateExecution: false,
    gatewayUrl: `${proxy.url}/v0/connect`,
  });
  onTestFinished(async () => {
    await connection.close();
  });
  await waitFor(() => {
    expect(connection.state).toBe(ConnectionState.ACTIVE);
  });

  // Trigger the function and wait for it to start executing.
  await client.send({ name: eventName });
  await state.waitForRunId();

  // Snapshot message counts right after the execution begins — before any
  // lease-extension intervals have had a chance to fire.
  const countsBefore = countMessages(proxy.forwardedClientMessages);

  // Initiate graceful shutdown. Also assert that the connection goes into a
  // `CLOSING` state.
  await Promise.all([
    connection.close(),
    waitFor(() => {
      expect(connection.state).toBe(ConnectionState.CLOSING);
    }),
  ]);

  expect(connection.state).toBe(ConnectionState.CLOSED);

  const result = await state.waitForRunComplete();
  expect(result).toBe("done");

  const countsAfter = countMessages(proxy.forwardedClientMessages);

  // Heartbeats must have continued while the worker was in `CLOSING` state.
  expect(
    countsAfter.heartbeats - countsBefore.heartbeats,
  ).toBeGreaterThanOrEqual(2);

  // No lease extensions should have been sent before `close()`. The execution
  // just started and the first interval hasn't fired yet.
  expect(countsBefore.leaseExtends).toBe(0);

  // Multiple lease extensions should have been sent while the worker was
  // waiting for the in-flight request to complete.
  expect(countsAfter.leaseExtends).toBeGreaterThanOrEqual(2);
}, 45_000);
