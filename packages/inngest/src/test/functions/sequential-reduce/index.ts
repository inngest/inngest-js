import { inngest } from "../client";

const scoresDb: Record<string, number> = {
  blue: 50,
  red: 25,
  green: 75,
};

export default inngest.createFunction(
  { id: "sequential-reduce" },
  { event: "demo/sequential.reduce" },
  async ({ step }) => {
    const teams = Object.keys(scoresDb);

    // Fetch every team's score sequentially and add them up
    const totalScores = await teams.reduce(async (score, team) => {
      const currentScore = await score;

      const teamScore = await step.run(
        `Get ${team} team score`,
        () => scoresDb[team],
      );

      return currentScore + teamScore;
    }, Promise.resolve(0));

    return totalScores;
  },
);
