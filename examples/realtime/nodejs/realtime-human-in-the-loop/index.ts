// This example demonstrates a human-in-the-loop workflow using Inngest's realtime features in Node.js
// It shows how to publish messages to a channel, wait for user confirmation, and continue the workflow based on input.

import { createServer } from "node:http";
import crypto from "node:crypto";

import { z } from "zod";
import {
  channel,
  realtimeMiddleware,
  subscribe,
  topic,
} from "@inngest/realtime";
import { EventSchemas, Inngest } from "inngest";
import { serve } from "inngest/node";

// Initialize the Inngest client with an ID, middleware, and event schemas
const inngest = new Inngest({
  id: "realtime-human-in-the-loop", // Unique identifier for this Inngest app
  middleware: [realtimeMiddleware()], // Enables realtime features
  schemas: new EventSchemas().fromZod({
    // Define the events this app will use
    "agentic-workflow/start": {}, // Event to start the workflow
    "agentic-workflow/confirmation": {
      data: z.object({
        confirmationUUid: z.string(), // Unique ID for confirmation
        confirmation: z.boolean(), // User's confirmation response
      }),
    },
  }),
});

// Create a realtime channel for the workflow, with a topic for messages
export const agenticWorkflowChannel = channel("agentic-workflow").addTopic(
  topic("messages").schema(
    z.object({
      message: z.string(), // Message to display to the user
      confirmationUUid: z.string(), // Unique ID to match confirmation
    })
  )
);

// Define the main workflow function
export const agenticWorkflow = inngest.createFunction(
  { id: "agentic-workflow", triggers: [{ event: "agentic-workflow/start" }] }, // Unique function ID, triggered by this event
  async ({ step, publish, logger }) => {
    logger.info("Starting agentic workflow");

    // Simulate some work by waiting 3 seconds
    logger.info("Waiting 3 seconds");
    await step.sleep("wait-3s", "3s");

    // Generate a unique identifier for the confirmation step
    const confirmationUUid = await step.run(
      "get-confirmation-uuid",
      async () => {
        return crypto.randomUUID();
      }
    );

    logger.info("Publishing confirmation message");

    // Publish a message to the channel asking for user confirmation
    await publish(
      agenticWorkflowChannel().messages({
        message: "Confirm to proceed?",
        confirmationUUid,
      })
    );

    // Wait for a confirmation event from the user, with a 15-minute timeout
    const confirmation = await step.waitForEvent("wait-for-confirmation", {
      event: "agentic-workflow/confirmation",
      timeout: "15m",
      // Only continue if the confirmationUUid matches
      if: `async.data.confirmationUUid == "${confirmationUUid}"`,
    });

    // Continue or cancel the workflow based on the user's response
    if (confirmation?.data?.confirmation) {
      // continue workflow
      logger.info("Workflow finished!");
    } else {
      logger.info("Workflow cancelled!");
    }
  }
);

// Start an HTTP server to serve the Inngest function
const serveApp = () => {
  createServer(
    serve({
      client: inngest,
      functions: [agenticWorkflow], // Register the workflow function
      // servePath: "/api/inngest", // Optionally customize the API path
    })
  ).listen(3000); // Listen on port 3000
};

// Subscribe to the channel and handle incoming messages and user input
const serverSubscription = async () => {
  // Wait for the app to sync with the Inngest DevServer (for local development)
  console.log("Waiting for app to sync with the Inngest DevServer");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  // Send the event to start the workflow
  await inngest.send({
    name: "agentic-workflow/start",
  });

  console.log("Sent agentic workflow start event");

  // Subscribe to the messages topic on the workflow channel
  const stream = await subscribe(
    {
      channel: agenticWorkflowChannel(),
      topics: ["messages"],
    },
    (message) => {
      // Log any messages received from the channel
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to agentic workflow channel");

  // Read messages from the stream and prompt the user for confirmation
  const reader = stream.getJsonStream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    } else if (value.data.confirmationUUid) {
      // If a confirmation is required, prompt the user
      console.log("Confirmation required. Type 'yes' to continue:");
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => {
          resolve(data.toString().trim());
        });
      });

      // Send the user's confirmation response as an event
      inngest.send({
        name: "agentic-workflow/confirmation",
        data: {
          confirmationUUid: value.data.confirmationUUid,
          confirmation: answer.toLowerCase() == "yes",
        },
      });
    }
  }
};

// Start both the HTTP server and the subscription handler
void Promise.all([serveApp(), serverSubscription()]);
