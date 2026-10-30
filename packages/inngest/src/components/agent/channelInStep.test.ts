/**
 * @module
 * Tests for the two forms of a report: in a step of its own (the default) and
 * on the caller's step, where the write is direct and a stream's state is kept
 * in the durable state.
 */
import { describe, expect, test } from "vitest";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { type ChannelCard, createReporter, defineChannel } from "./channels.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { run } from "./test-helpers.ts";

const surface = () => {
  const calls: string[] = [];
  let next = 0;
  const channel = defineChannel({
    post: async () => {},
    status: async (status) => {
      calls.push(`status:${status}`);
    },
    stream: {
      limits: { maxCards: 50, rollAt: 40, maxAgeMs: 9 * 60_000 },
      start: async (start) => {
        const id = `s${++next}`;

        calls.push(
          `start:${id}:${(start.cards ?? []).map((c: ChannelCard) => c.id).join(",")}`,
        );

        return id;
      },
      append: async (id, cards) => {
        calls.push(`append:${id}:${cards.map((c) => c.id).join(",")}`);
      },
      stop: async (id, final) => {
        calls.push(`stop:${id}:${final?.text ?? ""}`);
      },
    },
  });

  return { channel, calls };
};

const noSteps = async () => {
  throw new Error("a step of its own was made");
};

describe("report on the caller's step", () => {
  test("it writes directly, makes no step, and keeps the stream in the durable state", async () => {
    const { channel, calls } = surface();
    const held = new Map<string, unknown>();
    const state = {
      get: async (key: string) => {
        return held.get(key) as never;
      },
      set: async (key: string, value: unknown) => {
        held.set(key, value);
      },
    };
    const make = () => {
      return createReporter({ main: channel }, undefined, noSteps, undefined, {
        inStep: () => {
          return true;
        },
        state,
      });
    };

    const report = make();

    await report.status("working");
    await report.card({ id: "a", title: "A" });
    await report.card({ id: "b", title: "B" });

    // A later request of the run builds a new reporter (nothing in memory),
    // and the stream goes on where it was.
    const later = make();

    await later.card({ id: "c", title: "C" });
    await later.finish({ text: "Done." });
    await make().card({ id: "d", title: "D" });

    expect(calls).toEqual([
      "status:working",
      "start:s1:a",
      "append:s1:b",
      "append:s1:c",
      "stop:s1:Done.",
      "start:s2:d",
    ]);
  });

  test("the default form is unchanged: a step of its own, whose result carries the state", async () => {
    const { channel, calls } = surface();
    const ran: string[] = [];
    const report = createReporter(
      { main: channel },
      undefined,
      async (id, fn) => {
        ran.push(id);

        return fn();
      },
      undefined,
      {
        inStep: () => {
          return false;
        },
      },
    );

    await report.status("idle");
    await report.card({ id: "a", title: "A" });

    expect(ran).toEqual(["report:status:1:0:main", "report:card:1:0:main"]);
    expect(calls).toEqual(["status:idle", "start:s1:a"]);
  });
});

describe("report inside a step of the body", () => {
  test("reports made in the body's own steps add no step and the stream goes on across requests", async () => {
    const { channel, calls } = surface();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot", kv, channels: { main: channel } },
      async ({ step, report }) => {
        await step.run("mine", async () => {
          await report.status("working");
          await report.card({ id: "a", title: "A" });
        });
        await step.run("again", async () => {
          await report.card({ id: "b", title: "B" });
        });
        await step.run("last", async () => {
          await report.card({ id: "c", title: "C" });
        });
      },
    );

    // A report that made a step of its own inside the body's step would be a
    // nested step and throw. Each request of the run builds the reporter anew
    // and replays the steps already done without their writes, so the stream
    // goes on from the durable state, not from memory.
    await run(fn, {
      event: {
        name: "agent/message",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          text: "hi",
        },
      },
    });

    expect(calls).toEqual([
      "status:working",
      "start:s1:a",
      "append:s1:b",
      "append:s1:c",
    ]);
  });
});
