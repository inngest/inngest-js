import { step } from "inngest";
import { inngest } from "@/inngest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const GET = inngest.endpoint(async () => {
  const correlationId = await step.run("correlation-id", () =>
    crypto.randomUUID(),
  );

  await sleep(400);

  const result = await step.run("doing-really-hard-work", async () => {
    await sleep(400);
    return { work: "complete" };
  });

  return {
    id: correlationId,
    result: result,
  };
});
