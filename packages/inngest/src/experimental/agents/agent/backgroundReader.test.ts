/**
 * @module
 * The default handler reads the agent's inbox in the background: one read waits
 * beside the loop, and the fold before each model call takes from a queue. These
 * tests run the agent request by request against the fake executor, which
 * replays the whole run each time, and check that an arrival lands at the same
 * turn on every replay.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import type { AgentModelResponse } from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

const sender = { kind: "function", id: "caller", key: "r1", depth: 1 };

const start = (content: string, opened = false) => {
  return {
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content,
      ...(opened && { from: sender }),
    },
  };
};

const arriving = (content: string) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/bot`, thread: "t1", content },
  };
};

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const again: AgentModelResponse = {
  message: { role: "assistant", content: [] },
  toolCalls: [{ id: "c1", name: "missing", input: {} }],
};

/**
 * An agent whose model plays `script`. `calls` has the user messages each model
 * call that really ran was given. `log` is what every replay saw, in order:
 * `turn:N` as a turn finished and `fold:text` as a message was folded in; a
 * replay starts at each `turn:1`.
 */
const make = (
  script: AgentModelResponse[],
  options: { idle?: string; failOnce?: number } = {},
) => {
  freshKv();

  const calls: string[][] = [];
  const log: string[] = [];
  let failed = false;

  const { fn } = createAgentFunction(new Inngest({ id: testClientId }), {
    id: "bot",
    ...(options.idle && { idle: options.idle }),
    model: model(async (request) => {
      if (calls.length + 1 === options.failOnce && !failed) {
        failed = true;

        throw new Error("the model failed once");
      }

      calls.push(
        request.messages.flatMap((m) => {
          return m.role === "user" && typeof m.content === "string"
            ? [m.content]
            : [];
        }),
      );

      return script[calls.length - 1] ?? say("more");
    }),
    loop: {
      steer: (events: { data: unknown }[]) => {
        for (const event of events) {
          log.push(`fold:${(event.data as { content?: string }).content}`);
        }

        return events;
      },
      onTurn: (turn: { turn: number }) => {
        log.push(`turn:${turn.turn}`);
      },
    },
  } as never);

  // What each replay saw.
  const replays = () => {
    const chunks: string[][] = [];

    for (const entry of log) {
      if (entry === "turn:1") {
        chunks.push([]);
      }

      chunks.at(-1)?.push(entry);
    }

    return chunks;
  };

  return { fn, calls, replays };
};

// Every replay saw the same, as far as it got.
const consistent = (chunks: string[][]) => {
  const last = chunks.at(-1) ?? [];

  for (const chunk of chunks) {
    expect(last.slice(0, chunk.length)).toEqual(chunk);
  }

  return last;
};

describe("the default handler's background reader", () => {
  test("costs no step per turn: the fold takes from the queue", async () => {
    const { fn, calls } = make([again, again, say("done")]);
    const { ops, output } = await run(fn, { event: start("go", true) });

    expect(calls).toHaveLength(3);
    expect(output).toBe("done");

    // One read waits beside the run; none is a drain.
    expect(
      ops.filter((op) => {
        return op.op === "wait";
      }),
    ).toHaveLength(1);
    expect(
      ops.filter((op) => {
        return (
          op.op === "wait" &&
          (op.opts as { batch?: { drain?: boolean } }).batch?.drain === true
        );
      }),
    ).toHaveLength(0);
  });

  test.each(["during", "after"] as const)(
    "a message that arrives %s a long loop's second call is folded at the same turn on every replay",
    async (when) => {
      const { fn, calls, replays } = make(
        [again, again, again, again, say("done")],
        {},
      );
      const { output } = await run(fn, {
        event: start("go", true),
        arrive: [{ event: arriving("late"), at: "agent:model:2", when }],
      });
      const last = consistent(replays());
      const foldedBefore = last.indexOf("fold:late");

      expect(output).toBe("done");
      expect(last.filter((entry) => entry === "fold:late")).toHaveLength(1);

      // The turn the fold came before is the first live call that was given it.
      const turn = Number(last[foldedBefore + 1]?.split(":")[1]);
      const first = calls.findIndex((given) => {
        return given.includes("late");
      });

      expect(first + 1).toBe(turn);
      expect(turn).toBeGreaterThan(2);
      expect(
        calls.filter((given) => {
          return given.includes("late");
        }),
      ).toHaveLength(calls.length - first);
    },
  );

  test("a message that arrives while idle starts the next batch", async () => {
    const { fn, calls } = make([say("first"), say("second")]);
    const { waiting, ops } = await run(fn, {
      event: start("go"),
      incoming: [arriving("wake up")],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("wake up");
    expect(waiting).toBe(true);
    expect(
      ops.filter((op) => {
        return (
          op.op === "wait" &&
          (op.opts as { batch?: { drain?: boolean } }).batch?.drain === true
        );
      }),
    ).toHaveLength(0);
  });

  test("an idle that runs out ends the run", async () => {
    const { fn, calls } = make([say("first")], { idle: "5m" });
    const { output, waiting } = await run(fn, {
      event: start("go"),
      timeouts: 1,
    });

    expect(calls).toHaveLength(1);
    expect(waiting).toBe(false);
    expect(output).toBe("first");
  });

  test("a message that arrives before idle runs out wins the race, and the next wait is fresh", async () => {
    const { fn, calls } = make([say("first"), say("second")], { idle: "5m" });
    const { output, waiting } = await run(fn, {
      event: start("go"),
      incoming: [arriving("wake up")],
      timeouts: 0,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("wake up");
    expect(output).toBeUndefined();
    expect(waiting).toBe(true);
  });

  test("a model call that fails and is retried folds the arrival once, not twice", async () => {
    const { fn, calls, replays } = make(
      [again, again, again, again, say("done")],
      { failOnce: 3 },
    );
    const { output } = await run(fn, {
      event: start("go", true),
      arrive: [
        { event: arriving("late"), at: "agent:model:2", when: "during" },
      ],
    });
    const last = consistent(replays());

    expect(output).toBe("done");
    expect(last.filter((entry) => entry === "fold:late")).toHaveLength(1);
    expect(
      calls.filter((given) => {
        return given.filter((text) => text === "late").length > 1;
      }),
    ).toHaveLength(0);
  });

  test("a message that arrives as the run answers is not lost", async () => {
    const { fn, calls } = make([say("first"), say("second")]);
    const { output } = await run(fn, {
      event: start("go", true),
      arrive: [
        { event: arriving("last word"), at: "agent:model:1", when: "after" },
      ],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("last word");
    expect(output).toBe("second");
  });
});
