/**
 * @module
 * Proves the flow matrix (`kit/flow.ts`) on today's `waitForEvent`: the four
 * race shapes of `notes/prototype-race.md`. A step raced against a wait runs
 * its body once in all 8 cells, and `Promise.all` continues only after both
 * settle. Later tickets add their flows to this kit, not to this file.
 */
import {
  type Flow,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

const slow = (h: FlowHandle) => {
  return h.step.run("slow", async () => {
    h.ran("slow");
    h.mark("slow:start");
    await sleep(2000);
    h.mark("slow:end");

    return "slow-done";
  });
};

const wait = async (h: FlowHandle) => {
  const received = await h.step.waitForEvent("w", {
    event: h.event("w"),
    timeout: "1m",
    match: "data.key",
  });

  return received ? "w" : null;
};

const after = (h: FlowHandle) => {
  return h.step.run("after", async () => {
    h.ran("after");

    return "after-done";
  });
};

const raceEventMidStep: Flow = {
  name: "race-mid",
  run: async (h) => {
    return { winner: await Promise.race([slow(h), wait(h)]) };
  },
  drive: async (d) => {
    await d.reached("slow:start");
    await d.send("w");
  },
  expect: {
    output: { winner: "w" },
    bodies: { slow: 1 },
    rows: ["slow", "w"],
  },
};

const raceEventAfterStep: Flow = {
  name: "race-after",
  run: async (h) => {
    return { winner: await Promise.race([slow(h), wait(h)]) };
  },
  drive: async (d) => {
    await d.reached("slow:end");
    await d.send("w");
  },
  expect: {
    output: { winner: "slow-done" },
    bodies: { slow: 1 },
    rows: ["slow", "w"],
  },
};

const allEventMidStep: Flow = {
  name: "all-mid",
  run: async (h) => {
    const [a, b] = await Promise.all([slow(h), wait(h)]);

    return { a, b };
  },
  drive: async (d) => {
    await d.reached("slow:start");
    await d.send("w");
  },
  expect: {
    output: { a: "slow-done", b: "w" },
    bodies: { slow: 1 },
    rows: ["slow", "w"],
  },
};

const raceThenStep: Flow = {
  name: "race-then-step",
  run: async (h) => {
    const winner = await Promise.race([slow(h), wait(h)]);

    return { winner, after: await after(h) };
  },
  drive: async (d) => {
    await d.reached("slow:start");
    await d.send("w");
  },
  expect: {
    output: { winner: "w", after: "after-done" },
    bodies: { slow: 1, after: 1 },
    rows: ["slow", "w", "after"],
  },
};

export const harnessRace = flowScenario({
  id: "harness-race",
  owner: "sub-01-test-harnesses",
  flows: [raceEventMidStep, raceEventAfterStep, allEventMidStep, raceThenStep],
});
