import { inngest } from "./client";

export default inngest.createFunction(
  {
    id: "foo",
    retries: 0,
  },
  // @ts-ignore
  { event: "foo" },
  async ({ event, step }) => {
    const arr1 = [1, 2, 3, 4, 5, 6, 7];
    const arr2 = [1, 2, 3, 4, 5, 6, 7];

    await Promise.all(
      arr1.map(async (i) => {
        await step.run(`a.${i}`, async () => {});
        await step.run(`b.${i}`, async () => {});

        await Promise.all(
          arr2.map(async (j) => {
            return await step.run(`c.${i}`, async () => {});
          })
        );
      })
    );
  }
);
