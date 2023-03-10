import { inngest } from "../client";

export default inngest.createFunction(
  {
    name: "Error handler",
    retries: 1,
    /**
     * Once the function has exhausted all retries, the specified error handler
     * will be triggered.
     *
     * You could pass a common function in here to send alerts to an engineering
     * team, or that notified a user that something has failed.
     */
    onFailure: async ({ err, event, step }) => {
      err; // details of the error that caused the function to fail
      event.name; // "inngest/function.failed"
      event.data.event; // the original event that triggered the function

      /**
       * The failure function, like any others, can be a step function and be
       * broken up into multiple steps.
       */
      await Promise.all([
        step.run("Send alert to engineering team", async () => {
          // ....
        }),
        step.run("Notify user", async () => {
          // ...
        }),
      ]);
    },
  },
  { event: "foo" },

  /**
   * This function will throw an error when executed. By default, the function
   * will be retried 3 times.
   */
  () => {
    throw new Error("Something went wrong!");
  }
);
