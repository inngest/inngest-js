import { createServer } from "node:http";
import crypto from "node:crypto";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { agenticWorkflowChannel } from "./channels.js";

const inngest = new Inngest({
  id: "realtime-v2-human-in-the-loop",
});

export const agenticWorkflow = inngest.createFunction(
  { id: "agentic-workflow", triggers: [{ event: "agentic-workflow/start" }] },
  async ({ step, publish, logger }) => {
    logger.info("Starting agentic workflow");
    logger.info("Waiting 3 seconds");
    await step.sleep("wait-3s", "3s");

    const confirmationUUid = await step.run("get-confirmation-uuid", () =>
      crypto.randomUUID(),
    );
    logger.info("Publishing confirmation message");

    await publish(agenticWorkflowChannel.messages, {
      message: "Confirm to proceed?",
      confirmationUUid,
    });

    const confirmation = await step.waitForEvent("wait-for-confirmation", {
      event: "agentic-workflow/confirmation",
      timeout: "15m",
      if: `async.data.confirmationUUid == "${confirmationUUid}"`,
    });

    if (confirmation?.data?.confirmation) {
      logger.info("Workflow finished!");
    } else {
      logger.info("Workflow cancelled!");
    }
  }
);

const serveApp = () => {
  createServer(
    serve({
      client: inngest,
      functions: [agenticWorkflow],
    }),
  ).listen(3000, () => {
    console.log("Inngest serve handler listening on http://localhost:3000");
  });
};

const getConsoleAnswer = () =>
  new Promise<string>((resolve) => {
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });

const serverSubscription = async () => {
  console.log("Waiting for app to sync with the Inngest DevServer");
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  await inngest.send({ name: "agentic-workflow/start" });
  console.log("Sent agentic workflow start event");

  const stream = (await inngest.realtime.subscribe({
    // biome-ignore lint/suspicious/noExplicitAny: v2 channel typing is in flux on this branch
    channel: agenticWorkflowChannel as any,
    topics: ["messages"],
  } as any)) as any;

  console.log("Subscribed to agentic workflow channel");

  const reader = stream.getJsonStream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    console.log(`Received ${value.channel} ${value.topic} message:`, value.data);
    if (!value.data.confirmationUUid) {
      continue;
    }

    console.log("Confirmation required. Type 'yes' to continue:");
    const answer = await getConsoleAnswer();
    await inngest.send({
      name: "agentic-workflow/confirmation",
      data: {
        confirmationUUid: value.data.confirmationUUid,
        confirmation: answer.toLowerCase() === "yes",
      },
    });
  }
};

const run = async () => {
  serveApp();
  await serverSubscription();
};

void run();
