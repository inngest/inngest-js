import { inngest } from "../client";

export default inngest.createFunction(
  { id: "parallel-work" },
  { event: "demo/parallel.work" },
  async ({ step }) => {
    // Run some steps in sequence to add up scores
    const getScore = async () => {
      let score = await step.run("First score", () => 1);
      score += await step.run("Second score", () => 2);
      score += await step.run("Third score", () => 3);

      return score;
    };

    // Retrieve some fruits in parallel and return them as an array
    const getFruits = async () => {
      return Promise.all([
        step.run("Get apple", () => "Apple"),
        step.run("Get banana", () => "Banana"),
        step.run("Get orange", () => "Orange"),
      ]);
    };

    // Run both of the above functions in parallel and return the results
    return Promise.all([
      getScore(),
      getFruits().then((fruits) => fruits.join(", ")),
    ]);
  },
);
