import { step, stream } from "inngest";
import { getAsyncCtx } from "inngest/experimental";
import { inngest } from "@/inngest";
import { sleep, fakeTokenStream, collectString } from "../helpers";

const delay = 100;

export const GET = inngest.endpoint(async () => {
  console.log("enter");
  const ctx = await getAsyncCtx();
  const runId = ctx?.execution?.ctx?.runId;
  if (!runId) {
    // Unreachable
    throw new Error("No runId in context");
  }

  await step.run("first-llm", async () => {
    stream.push("First LLM call...");
    await sleep(delay);
    const [forStream] = fakeTokenStream([
      "Streaming back mock output",
      "Little more",
      "And done!",
    ]).tee();
    await stream.pipe(forStream);
  });

  await step.run("approval-message", () => {
    stream.push("Do you want to continue?");
  });

  const approval = await step.waitForEvent("wait-for-approval", {
    event: "approved",
    if: `async.data.runId == "${runId}"`,
    timeout: "5s",
  });
  if (!approval) {
    return "Approval expired";
  }

  // await step.run("second-llm", async () => {
  stream.push("Second LLM call...");
  await sleep(delay);
  const [forStream] = fakeTokenStream([
    "Streaming back mock output",
    "Little more",
    "And done!",
  ]).tee();
  await stream.pipe(forStream);
  // });

  return "Done";
});
