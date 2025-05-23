import crypto from "crypto";
import { subscribe } from "@inngest/realtime";
import { inngest } from "@/lib/inngest";

export async function POST() {
  // Generate a unique ID for Inngest function run
  const uuid = crypto.randomUUID();

  // The Inngest function will rely on this ID to publish messages
  // on a dedicated channel for this run.
  await inngest.send({
    name: "demo/multistep.start",
    data: {
      uuid,
    },
  });

  // Subscribe to the Inngest function's channel.
  const stream = await subscribe({
    channel: `multi-step-streaming-function.${uuid}`,
    topics: ["updates"], // subscribe to one or more topics in the user channel
  });

  // Stream the response to the client with Vercel's streaming response.
  return new Response(stream.getEncodedStream(), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
