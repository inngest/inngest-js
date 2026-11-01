/**
 * @module
 * Code that races a read against a step, or reads from a background loop while
 * the foreground runs steps, takes the same branch on every replay. Each flow
 * records which side won inside a step, then checks on every later replay that
 * the race settles the way it did when the step ran. The message is sent while
 * the step runs, after the step finishes, or before the race starts. All 8
 * cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */
import { flowScenario, sleep } from "../kit/flow.ts";
import { raceFlow } from "../kit/race.ts";

const sentMidStep = raceFlow("race-replay-mid-step", {
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:start");
    await d.send("msg", { n: 1 });
  },
});

const sentAfterStep = raceFlow("race-replay-after-step", {
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:end");
    await d.send("msg", { n: 1 });
  },
});

const sentBeforeRace = raceFlow("race-replay-before-race", {
  waitForSent: true,
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await sleep(1000);
    d.mark("sent");
  },
});

export const inboxRaceReplay = flowScenario({
  id: "inbox-race-replay",
  owner: "sub-14-race-determinism",
  flows: [sentMidStep, sentAfterStep, sentBeforeRace],
});
