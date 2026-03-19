import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { endpointAdapter } from "../../../edge.ts";
import { Inngest, step, stream } from "../../../index.ts";
import {
  createEndpointServer,
  createGate,
  pollForAsyncReader,
  startSSEReader,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test(
  "durable endpoint streams data before and after async mode",
  { timeout: 60000 },
  async () => {
    const state = createState({});
    const gates = {
      betweenSyncSteps: createGate(),
      insideAsyncStep: createGate(),
    };

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      endpointAdapter,
    });

    const handler = client.endpoint(async (_req: Request) => {
      await step.run("before-async-mode-1", async () => {
        stream.push("Hello\n");
      });

      // Used to for "stream is not buffered" assertion
      await gates.betweenSyncSteps.promise;

      await step.run("before-async-mode-2", async () => {
        stream.push("World\n");
      });

      // Force async mode
      await step.sleep("zzz", "1s");

      await step.run("after-async-mode", async () => {
        stream.push("Hola\n");

        // Used to for "stream is not buffered" assertion
        await gates.insideAsyncStep.promise;

        stream.push("mundo\n");
      });

      return new Response("All done");
    });

    const { port, server } = await createEndpointServer(handler);
    onTestFinished(() => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    // --- Phase 1: Initial sync request → SSE stream ---
    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const sse = startSSEReader(res, 15_000);

    // First chunk streamed
    await sse.waitForStreamData("Hello\n");
    expect(sse.streamData()).not.toContain("World\n");

    // Second chunk streamed
    gates.betweenSyncSteps.open();
    await sse.waitForStreamData("World\n");

    // Wait for the stream to close (i.e. endpoint goes async mode)
    await sse.done;

    const metadataEvents = sse.events.filter(
      (e) => e.event === "inngest.metadata",
    );
    expect(metadataEvents.length).toBe(1);
    const metadata = JSON.parse(metadataEvents[0]!.data);
    expect(metadata).toHaveProperty("run_id");
    state.runId = metadata.run_id;

    // Redirect since async mode necessitates streaming via Dev Server
    const redirectUrl = sse.getRedirectUrl();
    expect(redirectUrl).toBeTruthy();

    const sse2 = await pollForAsyncReader(redirectUrl!);

    // First chunk streamed
    await sse2.waitForStreamData("Hola\n");
    expect(sse2.streamData()).not.toContain("mundo\n");

    // Second chunk streamed
    gates.insideAsyncStep.open();
    await sse2.waitForStreamData("mundo\n");

    // Wait for the stream to close (i.e. endpoint returned)
    await sse2.done;

    // Result event with the function's return value
    const resultEvents = sse2.events.filter(
      (e) => e.event === "inngest.result",
    );
    expect(resultEvents.length).toBe(1);
    expect(JSON.parse(resultEvents[0]!.data)).toBe("All done");

    await state.waitForRunComplete();
  },
);
