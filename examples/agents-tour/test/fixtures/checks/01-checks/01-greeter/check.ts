export const check = async (t: {
  send: (agent: string, thread: string, text: string) => Promise<void>;
  settle: () => Promise<void>;
  runs: (fn?: string) => Promise<{ status: string; output: unknown }[]>;
  fail: (reason: string) => never;
}) => {
  await t.send("greeter", "ada", "Ada");
  await t.settle();

  const [run] = await t.runs("greeter");

  if (run?.output !== "Hello, Ada!") {
    t.fail(
      `The greeter returned ${JSON.stringify(run?.output ?? null)}, not "Hello, Ada!".`,
    );
  }
};
