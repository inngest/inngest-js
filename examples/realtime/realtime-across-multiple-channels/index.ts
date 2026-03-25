import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { createServer } from "node:http";
import { globalChannel, postChannel } from "./channels.js";

const app = new Inngest({
  id: "realtime-v2-across-channels",
});

const likePost = app.createFunction(
  {
    id: "post/like",
    retries: 0,
    triggers: [{ event: "app/post.like" }],
  },
  async ({
    event: {
      data: { postId = "123" },
    },
    step,
  }) => {
    if (!postId) {
      await app.realtime.publish(
        globalChannel.logs,
        "Missing postId when trying to like post",
      );
      throw new Error("Missing postId");
    }

    await app.realtime.publish(globalChannel.logs, `Liking post ${postId}`);

    const post = await step.run("update-likes", async () => {
      const fakePost = {
        id: postId,
        likes: Math.floor(Math.random() * 10000),
      };

      await app.realtime.publish(
        postChannel({ postId: fakePost.id }).updated,
        fakePost,
      );
      return fakePost;
    });

    return post;
  },
);

const serveApp = () => {
  createServer(
    serve({
      client: app,
      functions: [likePost],
    }),
  ).listen(3000, () => {
    console.log("Inngest serve handler listening on http://localhost:3000");
  });
};

const logsSubscription = async () => {
  await app.realtime.subscribe({
    channel: globalChannel,
    topics: ["logs"],
    onMessage: (message) => {
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data,
      );
    },
  });
  console.log("Subscribed to logs channel");
};

const postSubscription = async () => {
  await app.realtime.subscribe({
    channel: postChannel({ postId: "123" }),
    topics: ["updated", "deleted"],
    onMessage: (message) => {
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data,
      );
    },
  });
  console.log("Subscribed to post channel");
};

const periodicLike = async () => {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await app.send({ name: "app/post.like", data: { postId: "123" } });
  }
};

const run = async () => {
  serveApp();
  console.log("Waiting for app to sync with the Inngest dev server...");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await Promise.all([logsSubscription(), postSubscription(), periodicLike()]);
};

void run();
