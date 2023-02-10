import { inngest } from "../client";

export default inngest.createFunction(
  { name: "Polling" },
  { event: "demo/polling" },
  async ({ step }) => {
    const poll = async () => {
      let timedOut = false;
      void step.sleep("30s").then(() => (timedOut = true));

      do {
        const jobData = await step.run("Check if external job complete", () => {
          const jobComplete = Math.random() > 0.5;

          if (jobComplete) {
            return { data: { foo: "bar" } };
          }

          return null;
        });

        if (jobData !== null) {
          return jobData;
        }

        await step.sleep("10s");
      } while (!timedOut);

      return null;
    };

    const jobData = await poll();

    if (jobData) {
      await step.run("Do something with data", () => {
        console.log(jobData);
      });
    }
  }
);
