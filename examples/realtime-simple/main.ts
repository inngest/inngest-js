import { EventSchemas, Inngest } from "inngest";
import { channel, topic } from "inngest/experimental";
import { serve } from "inngest/node";
import { createServer } from "node:http";
import { z } from "zod";

const app = new Inngest({
  id: "realtime-simple",
  schemas: new EventSchemas().fromZod({
    "app/post.like": { data: z.object({ postId: z.string() }) },
  }),
});

// Create some channels to help with typing
const globalChannel = channel("global").addTopic(topic("logs").type<string>());

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

const likePost = app.createFunction(
  {
    id: "post/like",
    retries: 0,
  },
  {
    event: "app/post.like",
  },
  async ({
    event: {
      data: { postId = "123" },
    },
    step,
    publish,
  }) => {
    if (!postId) {
      await publish(
        globalChannel().logs("Missing postId when trying to like post")
      );
      throw new Error("Missing postId");
    }

    await publish(globalChannel().logs(`Liking post ${postId}`));

    // Fake a post update
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

const serveApp = () => {
  createServer(
    serve({
      client: app,
      functions: [likePost],
    })
  ).listen(3000);
};

const logsSubscription = async () => {
  await app.subscribe(
    {
      channel: globalChannel(),
      topics: ["logs"],
    },
    (message) => {
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to logs channel");
};

const postSubscription = async () => {
  await app.subscribe(
    {
      channel: postChannel("123"),
      topics: ["updated", "deleted"],
    },
    (message) => {
      console.log(
        `Received ${message.channel} ${message.topic} message:`,
        message.data
      );
    }
  );

  console.log("Subscribed to post channel");
};

const periodicLike = async () => {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await app.send({ name: "app/post.like", data: { postId: "123" } });
  }
};

void Promise.all([
  serveApp(),
  logsSubscription(),
  postSubscription(),
  periodicLike(),
]);
