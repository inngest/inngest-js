import { step, stream } from "inngest";
import { getAsyncCtx } from "inngest/experimental";
import { inngest } from "@/inngest";
import { sleep, fakeTokenStream, collectString } from "../helpers";

const delay = 1000;

export const GET = inngest.endpoint(async () => {
  const ctx = await getAsyncCtx();
  const runId = ctx?.execution?.ctx?.runId;
  if (!runId) {
    // Unreachable
    throw new Error("No runId in context");
  }

  await step.run("first-llm", async () => {
    stream.push("First LLM call:\n");
    await sleep(delay);
    const [forStream] = fakeTokenStream([
      "Hello ",
      "from ",
      "another ",
      "stream!\n",
    ]).tee();
    await stream.pipe(forStream);
  });

  await step.run("approval-message", () => {
    stream.push("Do you want to continue?\n");
  });

  const approval = await step.waitForEvent("wait-for-approval", {
    event: "approved",
    if: `async.data.runId == "${runId}"`,
    timeout: "5s",
  });
  if (!approval) {
    return "Approval expired\n";
  }
  if (!approval.data.approved) {
    return "Denied!\n";
  }

  await step.run("second-llm", async () => {
    // await sleep(10000)
    stream.push("Approved!\n");
    await sleep(5000);
    stream.push("Second LLM call:\n");
    await sleep(delay);
    const [forStream] = fakeTokenStream([
      "Hello ",
      "from ",
      "yet ",
      "another ",
      "stream!\n",
    ]).tee();
    await stream.pipe(forStream);
  });

  return "Done\n";
});
