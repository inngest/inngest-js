// This example demonstrates subscribing to multiple channels and topics using Inngest's realtime features in Node.js
// It shows how to publish and subscribe to logs and post updates across different channels.

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
  id: "realtime-simple", // Unique identifier for this Inngest app
  middleware: [realtimeMiddleware()], // Enables realtime features
  schemas: new EventSchemas().fromZod({
    // Define the event for liking a post
    "app/post.like": { data: z.object({ postId: z.string() }) },
  }),
});

// Create a global channel for logs
const globalChannel = channel("global").addTopic(topic("logs").type<string>());

// Create a post channel, parameterized by postId, with topics for updates and deletions
const postChannel = channel((postId: string) => `post:${postId}`)
  .addTopic(
    topic("updated").schema(
      z.object({
        id: z.string(),
        likes: z.number(),
      })
    )
  )
  .addTopic(
    topic("deleted").schema(
      z.object({
        id: z.string(),
        reason: z.string(),
      })
    )
  );

// Define the function that handles post likes and publishes updates
const likePost = app.createFunction(
  {
    id: "post/like", // Unique function ID
    retries: 0, // No retries for this example
    triggers: [{ event: "app/post.like" }], // Triggered by this event
  },
  async ({
    event: {
      data: { postId = "123" },
    },
    step,
    publish,
  }) => {
    if (!postId) {
      // Publish an error log if postId is missing
      await publish(
        globalChannel().logs("Missing postId when trying to like post")
      );
      throw new Error("Missing postId");
    }

    // Publish a log for liking the post
    await publish(globalChannel().logs(`Liking post ${postId}`));

    // Simulate a post update and publish the updated post
    const post = await step.run("Update likes", async () => {
      const fakePost = {
        id: "123",
        likes: Math.floor(Math.random() * 10000),
      };

      return publish(postChannel(fakePost.id).updated(fakePost));
    });

    return post;
  }
);

// Start an HTTP server to serve the Inngest function
const serveApp = () => {
  createServer(
    serve({
      client: app,
      functions: [likePost], // Register the likePost function
    })
  ).listen(3000); // Listen on port 3000
};

// Subscribe to the global logs channel
const logsSubscription = async () => {
  await subscribe(
    {
      channel: globalChannel(),
      topics: ["logs"],
    },
    (message) => {
      // Log any messages received from the logs channel
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to logs channel");
};

// Subscribe to the post channel for updates and deletions
const postSubscription = async () => {
  await subscribe(
    {
      channel: postChannel("123"),
      topics: ["updated", "deleted"],
    },
    (message) => {
      // Log any messages received from the post channel
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to post channel");
};

// Periodically send a like event to simulate activity
const periodicLike = async () => {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await app.send({ name: "app/post.like", data: { postId: "123" } });
  }
};

// Start the HTTP server, log subscription, post subscription, and periodic like sender
void Promise.all([
  serveApp(),
  logsSubscription(),
  postSubscription(),
  periodicLike(),
]);
