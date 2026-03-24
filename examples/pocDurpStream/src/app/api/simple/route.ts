import { step, stream } from "inngest";
import { inngest } from "@/inngest";

export const GET = inngest.endpoint(async () => {
  await step.run("before-async-mode-1", async () => {
    // Streamed directly to the client
    stream.push("Hello\n");
  });

  await step.run("before-async-mode-2", async () => {
    // Streamed directly to the client
    stream.push("World\n");
  });

  // Force async mode
  await step.sleep("zzz", "1s");
  
  await step.run("after-async-mode", async () => {
    // Streamed to the client via the IS
    stream.push("Hola\n");
    stream.push("mundo\n");
  });

  // Streamed to the client via the IS
  return new Response("All done", { status: 200 });
});
