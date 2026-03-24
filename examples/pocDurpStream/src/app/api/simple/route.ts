import { step, stream } from "inngest";
import { inngest } from "@/inngest";

export const GET = inngest.endpoint(async () => {
  await step.run("before-async-mode-1", async () => {
    stream.push("Hello\n");
  });

  await step.run("before-async-mode-2", async () => {
    stream.push("World\n");
    return "a";
  });

  // Force async mode
  await step.sleep("zzz", "1s");

  await step.run("after-async-mode", async () => {
    stream.push("Hola\n");
    stream.push("mundo\n");
    return "b";
  });
});
