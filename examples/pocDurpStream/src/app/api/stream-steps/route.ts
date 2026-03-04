import { step, stream } from "inngest";
import { inngest } from "@/inngest";
import { sleep, fakeTokenStream, collectString } from "../helpers";

const delay = 100;

export const GET = inngest.endpoint(async () => {
  console.log("reenter");
  await step.run("stream demo", async () => {
    stream.push("Yo, I'll wait 2 seconds and then give you some JSON");
    await sleep(delay);
    stream.push({ message: "Here's that JSON I mentioned" });
    await sleep(delay);

    stream.push("For my next trick, I'll demonstrate stream teeing");
    await sleep(delay);
    stream.push("First, you'll see the new stream's output in your stream");

    // Tee a source stream: one side streams live, the other collects a buffer
    const [forStream, forBuffer] = fakeTokenStream([
      "Hello ",
      "from ",
      "the ",
      "other ",
      "stream!",
    ]).tee();
    const [, buffered] = await Promise.all([
      stream.pipe(forStream),
      collectString(forBuffer),
    ]);

    await sleep(delay);
    stream.push("Next, you'll see the same output but buffered");
    await sleep(delay);
    stream.push(buffered);
    await sleep(delay);
  });

  await step.run("before-sleep", async () => {
    await stream.push("Now I'll sleep with step.sleep 😴");
  });
  await step.sleep("zzz", "1s");

  await step.run("return value", async () => {
    stream.push("Finally, you'll get the return value of the endpoint");
    await sleep(delay);
  });
  return "I'm the return value";
});
