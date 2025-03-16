import crypto from "crypto";
import { inngest } from "@/inngest/client";
import { Realtime, subscribe } from "@inngest/realtime";

function createWebStream(stream: Realtime.Subscribe.StreamSubscription<any>) {
  return new ReadableStream({
    async start(controller) {
      for await (const message of stream) {
        controller.enqueue(JSON.stringify(message));
      }
      controller.close();
    }
  })
}

export async function POST(req: Request) {
  const json = await req.json();
  const { prompt } = json;

  console.log(json);
 
  const uuid = crypto.randomUUID();

  await inngest.send({
    name: "app/simple-search-agent.run",
    data: {
      uuid,
      input: prompt,
    },
  });

  const stream = await subscribe(inngest, {
    channel: `simple-search.${uuid}`,
    topics: ["updates"], // subscribe to one or more topics in the user channel
  });
  
  return new Response(createWebStream(stream), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    },
  });
}