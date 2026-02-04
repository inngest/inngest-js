// This example demonstrates subscribing to a single run of a workflow using Inngest's realtime features in Node.js
// It shows how to publish status updates to a channel and subscribe to updates for a specific upload process.

import crypto from "node:crypto";
import {
  channel,
  realtimeMiddleware,
  subscribe,
  topic,
} from "@inngest/realtime";
import { EventSchemas, Inngest } from "inngest";
import { serve } from "inngest/node";
import { createServer } from "node:http";
import { z } from "zod";

// Initialize the Inngest client with an ID, middleware, and event schemas
const app = new Inngest({
  id: "realtime-single-run", // Unique identifier for this Inngest app
  middleware: [realtimeMiddleware()], // Enables realtime features
  schemas: new EventSchemas().fromZod({
    // Define the event for processing uploads
    "app/process-upload": {
      data: z.object({ uploadId: z.string(), uuid: z.string() }),
    },
  }),
});

// Create a channel for uploads, parameterized by uuid, with a topic for statuses
const uploadsChannel = channel((uuid: string) => `uploads:${uuid}`).addTopic(
  topic("statuses").type<string>()
);

// Define the function that processes an upload and publishes status updates
const uploadFile = app.createFunction(
  {
    id: "upload-file", // Unique function ID
    retries: 0, // No retries for this example
    triggers: [{ event: "app/process-upload" }], // Triggered by this event
  },
  async ({
    event: {
      data: { uploadId = "123", uuid },
    },
    step,
    publish,
  }) => {
    if (!uploadId) {
      // Publish an error status if uploadId is missing
      await publish(
        uploadsChannel(uuid).statuses(
          `Missing uploadId when trying to process upload`
        )
      );
      throw new Error("Missing uploadId");
    }

    // Publish a status update for processing
    await publish(
      uploadsChannel(uuid).statuses(`Processing upload ${uploadId}`)
    );

    // Simulate upload processing and publish a final status
    await step.run("Process upload", async () => {
      return publish(
        uploadsChannel(uuid).statuses(`Upload ${uploadId} processed`)
      );
    });
  }
);

// Start an HTTP server to serve the Inngest function
const serveApp = () => {
  createServer(
    serve({
      client: app,
      functions: [uploadFile], // Register the upload function
    })
  ).listen(3000); // Listen on port 3000
};

// Subscribe to status updates for a single upload run
const uploadSubscription = async () => {
  // Wait for the app to sync with the Inngest DevServer (for local development)
  console.log("Waiting for app to sync with the Inngest DevServer");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  const uuid = crypto.randomUUID(); // Unique ID for the upload to follow

  // Trigger 5 uploads, but only subscribe to the first one
  for (let i = 0; i < 5; i++) {
    await app.send({
      name: "app/process-upload",
      data: {
        uploadId: i.toString(),
        uuid: i === 0 ? uuid : crypto.randomUUID(),
      },
    });
  }

  // Subscribe to status updates for the first upload
  await subscribe(
    {
      channel: uploadsChannel(uuid),
      topics: ["statuses"],
    },
    (message) => {
      // Log any status messages received from the channel
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to uploads #1 status updates");
};

// Start both the HTTP server and the subscription handler
void Promise.all([serveApp(), uploadSubscription()]);
