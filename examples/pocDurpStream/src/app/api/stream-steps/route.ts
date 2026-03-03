import { step, stream } from "inngest";
import { inngest } from "@/inngest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a fake upstream source that emits chunks over time,
 * like an LLM token stream.
 */
function createSource(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = ["Hello ", "from ", "the ", "other ", "stream!"];

  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await sleep(500);
      }
      controller.close();
    },
  });
}

const delay = 200;
export const GET = inngest.endpoint(async () => {
  await step.run("stream demo", async () => {
    stream.push("Yo, I'll wait 2 seconds and then give you some JSON");
    await sleep(delay);
    stream.push({ message: "Here's that JSON I mentioned" })
    await sleep(delay);

    stream.push("For my next trick, I'll demonstrate stream teeing")
    await sleep(delay);
    stream.push("First, you'll see the new stream's output in your stream")
    const source = createSource();
    const [forStream, forBuffer] = source.tee();

    // Tee 1: pipe into the durable stream so the client sees chunks live
    const pipePromise = stream.pipe(forStream);

    // Tee 2: collect into a buffer
    const reader = forBuffer.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      parts.push(decoder.decode(value, { stream: true }));
    }

    const buffered = parts.join("");

    // Wait for the pipe to finish
    await pipePromise;

    await sleep(delay);
    stream.push("Next, you'll see the same output but buffered")
    await sleep(delay);
    stream.push(buffered);
    await sleep(delay);
  })


  await step.run("return value", async () => {
    stream.push("Finally, you'll get the return value of the endpoint")
    await sleep(delay);
  })
  return "I'm the return value"
});
