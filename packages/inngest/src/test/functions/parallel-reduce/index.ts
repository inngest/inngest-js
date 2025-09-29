import { inngest } from "../client";

const scoresDb: Record<string, number> = {
  blue: 50,
  red: 25,
  green: 75,
};

export default inngest.createFunction(
  { id: "parallel-reduce" },
  { event: "demo/parallel.reduce" },
  async ({ step }) => {
    const teams = Object.keys(scoresDb);

    // Fetch every team's score in parallel and add them up
    const totalScores = await teams.reduce(async (score, team) => {
      const teamScore = await step.run(
        `Get ${team} team score`,
        () => scoresDb[team],
      );

      return (await score) + teamScore;
    }, Promise.resolve(0));

    return totalScores;
  },
);
