/**
 * @module
 * Pieces shared by the flows that race a read against a step: a flow that
 * records which side won inside a step, then checks on every later replay that
 * the race settles the way it did when the step ran.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */
import { type Flow, type FlowDriver, type FlowHandle, sleep } from "./flow.ts";

export const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

export const slow = (h: FlowHandle) => {
  return h.step.run("slow", async () => {
    h.ran("slow");
    h.mark("slow:start");
    await sleep(2000);
    h.mark("slow:end");

    return "slow-done";
  });
};

export const record = (h: FlowHandle, value: unknown) => {
  return h.step.run("record", () => {
    h.ran("record");

    return value;
  });
};

export const tail = (h: FlowHandle) => {
  return h.step.run("tail", () => {
    h.ran("tail");

    return "tail-done";
  });
};

export const agree = (recorded: unknown, now: unknown) => {
  if (recorded !== now) {
    throw new Error(
      `the race settled with ${now}, it was recorded as ${recorded}`,
    );
  }
};

export const raceFlow = (
  name: string,
  options: {
    waitForSent?: boolean;
    read?: (
      inbox: ReturnType<FlowHandle["step"]["subscribe"]>,
    ) => Promise<unknown>;
    drive: (d: FlowDriver) => Promise<void>;
  },
): Flow => {
  return {
    name,
    run: async (h) => {
      const inbox = h.step.subscribe("inbox", source(h));

      try {
        if (options.waitForSent) {
          await h.until("sent");
        }

        const winner = await Promise.race([
          slow(h).then(() => {
            return "step";
          }),
          (options.read ?? ((i) => i.next()))(inbox).then(() => {
            return "message";
          }),
        ]);
        const recorded = await record(h, winner);

        agree(recorded, winner);

        await tail(h);

        agree(recorded, winner);

        return { consistent: true };
      } finally {
        await inbox.close();
      }
    },
    drive: options.drive,
    expect: {
      output: { consistent: true },
      bodies: { slow: 1, record: 1, tail: 1 },
      ...(options.read
        ? {}
        : { rows: ["inbox", "inbox:close", "record", "slow", "tail"] }),
    },
  };
};
