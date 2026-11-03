export const check = async (t: any) => {
  await t.send("echo", "a", "1");
  await t.send("echo", "b", "2");
  await t.settle();

  const threads = await t.threads();
  const keys = threads.map((thread: any) => thread.key).sort();

  if (JSON.stringify(keys) !== JSON.stringify(["a", "b"])) {
    t.fail(`Threads: ${JSON.stringify(keys)}.`);
  }

  if (threads.some((thread: any) => thread.runs.length !== 1)) {
    t.fail("Each thread should hold one run.");
  }
};
