export const check = async (t: any) => {
  await t.event("tour/greet", { name: "Ada" });
  await t.press("/api/event", { name: "tour/greet", data: { name: "Bo" } });
  await t.event("tour/other", { name: "Cy" });
  await t.settle();

  const greeted = await t.runs("greeter");
  const outputs = greeted.map((run: any) => run.output).sort();

  if (
    JSON.stringify(outputs) !== JSON.stringify(["Hello, Ada!", "Hello, Bo!"])
  ) {
    t.fail(`The greeter returned ${JSON.stringify(outputs)}.`);
  }

  if ((await t.runs()).length !== 3) {
    t.fail("Expected three runs in all.");
  }
};
