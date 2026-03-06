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
  "durable endpoint streams SSE, sleeps, and resumes",
  { timeout: 15000 },
  async () => {
    const state = createState({});
    const gates = {
      a: createGate(),
      b: createGate(),
    };

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      endpointAdapter,
    });

    const handler = client.endpoint(async (_req: Request) => {
      await step.run("a", async () => {
        stream.push("a.1\n");
        await gates.a.promise;
        stream.push("a.2\n");
      });

      // Forces async mode (reentry via dev server)
      await step.sleep("zzz", "1s");

      await step.run("b", async () => {
        stream.push("b.1\n");
        await gates.b.promise;
        stream.push("b.2\n");
      });

      return new Response("Done\n");
    });

    const { port, server } = await createEndpointServer(handler);
    onTestFinished(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    // --- Phase 1: Initial sync request → SSE stream ---
    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const sse = startSSEReader(res, 15_000);

    // a.1 should arrive while the gate is still closed
    await sse.waitForStreamData("a.1\n");
    expect(sse.streamData()).not.toContain("a.2\n");

    // Release the gate → a.2 flows through
    gates.a.open();
    await sse.waitForStreamData("a.2\n");

    // Wait for the stream to close (redirect after sleep)
    await sse.done;

    // Metadata event with run_id
    const metadataEvents = sse.events.filter((e) => e.event === "inngest");
    expect(metadataEvents.length).toBe(1);
    const metadata = JSON.parse(metadataEvents[0]!.data);
    expect(metadata).toHaveProperty("run_id");
    state.runId = metadata.run_id;

    // sleep forces async → redirect event tells client where to reconnect
    const redirectUrl = sse.getRedirectUrl();
    expect(redirectUrl).toBeTruthy();

    // --- Phase 2: Follow redirect → remaining stream data after sleep ---
    const sse2 = await pollForAsyncReader(redirectUrl!);

    // b.1 should arrive while the gate is still closed
    await sse2.waitForStreamData("b.1\n");
    expect(sse2.streamData()).not.toContain("b.2\n");

    // Release the gate → b.2 flows through
    gates.b.open();
    await sse2.waitForStreamData("b.2\n");

    await sse2.done;

    // Terminal result event with the function's return value
    const resultEvents = sse2.events.filter((e) => e.event === "result");
    expect(resultEvents.length).toBe(1);
    expect(JSON.parse(resultEvents[0]!.data)).toBe("Done\n");

    await state.waitForRunComplete();
  },
);
