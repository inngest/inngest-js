import { inngest } from "@/inngest/client";
import { subscribe } from "@inngest/realtime";

export async function POST(req: Request) {
  await inngest.send({
    name: "app/hello-world.run",
  });

  const stream = await subscribe(inngest, {
    channel: `hello-world`,
    topics: ["messages"],
  });

  return new Response(stream.getEncodedStream(), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
