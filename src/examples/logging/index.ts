import { inngest } from "../client";

export default inngest.createFunction(
  { name: "Logging" },
  { event: "demo/logging" },
  async ({ step, console }) => {
    const obj = { foo: "bar" };
    const etc = "etc";

    console.log("Info", obj, etc);
    console.debug("Debug", obj, etc);
    console.error("Error", obj, etc);
    console.info("Info", obj, etc);
    console.trace("Trace", obj, etc);
    console.warn("Warn", obj, etc);

    await step.run("Logging works inside steps, too", async () => {
      console.log(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log(2);

      return "Done";
    });
  }
);
