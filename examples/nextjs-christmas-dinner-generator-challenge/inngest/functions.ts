import { inngest } from "@/inngest/client";

export const generateMeal = inngest.createFunction(
  { id: "generate-meal", triggers: [{ event: "meal.generate" }] },
  async ({ event, step }) => {
    const { participantsCount, preferences } = event.data;

    await step.run("hello", async () => {
      console.log("Hello, world!");
      console.log(
        `Received ${participantsCount} participants with the following preferences: ${preferences}`
      );
    });

    await step.sleep("sleep-1s", 1000);

    await step.run("final-step", async () => {
      console.log("Final step");
    });
  }
);

export const functions = [generateMeal];
