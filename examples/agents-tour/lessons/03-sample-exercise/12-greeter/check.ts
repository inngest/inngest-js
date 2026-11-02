import type { Check } from "../../../shared/check.ts";

export const check: Check = async (t) => {
  await t.send("greeter", "ada", "Ada");
  await t.settle();

  const [run] = await t.runs("greeter");

  if (run?.output !== "Hello, Ada!") {
    t.fail(
      `The greeter returned ${JSON.stringify(run?.output ?? null)}, not "Hello, Ada!".`,
    );
  }
};
