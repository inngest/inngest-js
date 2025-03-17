import crypto from "crypto";
import { inngest } from "@/inngest/client";
import { subscribe } from "@inngest/realtime";

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

  return new Response(stream.getEncodedStream(), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
