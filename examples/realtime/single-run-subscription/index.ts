import crypto from "node:crypto";
import { createServer } from "node:http";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { uploads } from "./channels.js";

const inngest = new Inngest({ id: "realtime-v2-example" });

//
// Function that processes an upload and publishes status updates
const uploadFile = inngest.createFunction(
  {
    id: "upload-file",
    retries: 0,
    triggers: [{ event: "app/process-upload" }],
  },
  async ({ event, step, publish }) => {
    const { uploadId, uuid } = event.data as {
      uploadId: string;
      uuid: string;
    };
    const ch = uploads({ uuid });

    await publish(ch.status, {
      message: `Processing upload ${uploadId}`,
      uploadId,
    });

    await step.run("process-upload", async () => {
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    //
    // Durable publish — memoized, won't re-fire on retry
    //
    await step.realtime.publish("publish-result", ch.result, {
      success: true,
      uploadId,
    });

    await publish(ch.status, {
      message: `Upload ${uploadId} complete`,
      uploadId,
    });
  },
);

//
// Start the HTTP server that serves the Inngest function
const startServer = () => {
  createServer(
    serve({
      client: inngest,
      functions: [uploadFile],
    }),
  ).listen(3000, () => {
    console.log("Inngest serve handler listening on http://localhost:3000");
  });
};

//
// Subscribe to status updates for a single upload
//
const runSubscription = async () => {
  console.log("Waiting for app to sync with the Inngest dev server...");
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const uuid = crypto.randomUUID();
  const ch = uploads({ uuid });

  console.log(`\nSubscribing to channel: ${ch.name}`);
  console.log("Topics: status, result\n");

  //
  // Subscribe to the channel using the Inngest client
  //
  const stream = await inngest.realtime.subscribe({
    channel: ch,
    topics: ["status", "result"],
  });

  //
  // Read messages from the stream
  //
  const reader = stream.getJsonStream().getReader();

  const readMessages = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("Stream closed");
        break;
      }
      console.log(`[${value.topic}]`, value.data);
    }
  };

  // Start reading in the background
  readMessages().catch(console.error);

  // Trigger 5 uploads — only the first uses our tracked uuid
  for (let i = 0; i < 5; i++) {
    await inngest.send({
      name: "app/process-upload",
      data: {
        uploadId: i.toString(),
        uuid: i === 0 ? uuid : crypto.randomUUID(),
      },
    });
  }

  console.log(
    `\nSent 5 upload events. Only upload #0 (uuid: ${uuid}) is subscribed.\n`,
  );
};

void Promise.all([startServer(), runSubscription()]);
