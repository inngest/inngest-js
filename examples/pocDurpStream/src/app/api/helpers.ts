export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates an upstream source that emits chunks over time (like an LLM).
 */
export function fakeTokenStream(tokens: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      for (const token of tokens) {
        controller.enqueue(encoder.encode(token));
        await sleep(500);
      }
      controller.close();
    },
  });
}

/**
 * Read a stream to completion and return its contents as a string.
 */
export async function collectString(readable: ReadableStream): Promise<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }
    parts.push(decoder.decode(value, { stream: true }));
  }

  return parts.join("");
}
