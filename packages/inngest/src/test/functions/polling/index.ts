import { inngest } from "../client";

export default inngest.createFunction(
  { id: "polling" },
  { event: "demo/polling" },
  async ({ step }) => {
    const poll = async () => {
      let timedOut = false;
      void step.sleep("polling-time-out", "30s").then(() => (timedOut = true));
      let interval = 0;

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

        await step.sleep(`interval-${interval++}`, "10s");
      } while (!timedOut);

      return null;
    };

    const jobData = await poll();

    if (jobData) {
      await step.run("Do something with data", () => {
        console.log(jobData);
      });
    }
  },
);
