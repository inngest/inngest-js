/**
 * @module
 * Tests for the limits of a channel's progress stream: rolling over before a
 * surface's card cap, starting a new stream when one ends or ages out,
 * dropped-update warnings as errors, ordered writes, and replay.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type ChannelCard,
  ChannelStreamEnded,
  createReporter,
  defineChannel,
} from "./channels.ts";
import { slack } from "./slack.ts";

/**
 * A fake surface with Slack's rules: a stream holds at most `maxCards` unique
 * cards, ends after `endAfterWrites` writes when set, and records every call.
 */
const fakeSurface = (
  options: {
    maxCards?: number;
    rollAt?: number;
    endAfterWrites?: number;
    maxAgeMs?: number;
  } = {},
) => {
  const maxCards = options.maxCards ?? 50;
  const streams = new Map<
    string,
    { cards: Map<string, ChannelCard>; writes: number; stopped: boolean }
  >();
  const calls: string[] = [];
  let next = 0;

  const channel = defineChannel({
    post: async () => {},
    stream: {
      limits: {
        maxCards,
        rollAt: options.rollAt ?? Math.max(1, maxCards - 10),
        maxAgeMs: options.maxAgeMs ?? 9 * 60_000,
      },
      start: async () => {
        const id = `stream${++next}`;

        streams.set(id, { cards: new Map(), writes: 0, stopped: false });
        calls.push(`start:${id}`);

        return id;
      },
      append: async (id, cards) => {
        const stream = streams.get(id);

        if (
          !stream ||
          stream.stopped ||
          (options.endAfterWrites !== undefined &&
            stream.writes >= options.endAfterWrites)
        ) {
          throw new ChannelStreamEnded();
        }

        for (const card of cards) {
          stream.cards.set(card.id, card);
        }

        if (stream.cards.size > maxCards) {
          throw new Error(`${id} holds ${stream.cards.size} cards`);
        }

        stream.writes += 1;
        calls.push(`append:${id}:${cards.map((c) => c.id).join(",")}`);
      },
      stop: async (id) => {
        const stream = streams.get(id);

        if (stream) {
          stream.stopped = true;
        }

        calls.push(`stop:${id}`);
      },
    },
  });

  return { channel, streams, calls };
};

/**
 * Runs a step the way the executor does: live, or from `saved` by step ID.
 */
const stepper = (saved: Record<string, unknown> = {}) => {
  const results: Record<string, unknown> = {};
  const ran: string[] = [];

  return {
    results,
    ran,
    runStep: async (id: string, fn: () => Promise<number | undefined>) => {
      if (id in saved) {
        return saved[id];
      }

      ran.push(id);
      results[id] = await fn();

      return results[id];
    },
  };
};

describe("report.card", () => {
  test("100 unique cards never put more than the cap in one stream", async () => {
    const surface = fakeSurface({ maxCards: 50 });
    const { runStep } = stepper();
    const report = createReporter(
      { main: surface.channel },
      undefined,
      runStep,
    );

    for (let i = 1; i <= 100; i++) {
      await report.card({
        id: `c${i}`,
        title: `Step ${i}`,
        status: "running",
      });
    }

    for (const stream of surface.streams.values()) {
      expect(stream.cards.size).toBeLessThanOrEqual(50);
    }

    // 40 cards fill a stream, then each new one starts with a summary and the
    // card at hand, never the history.
    expect(surface.streams.size).toBe(3);
    expect(surface.calls.filter((c) => c.startsWith("start:"))).toHaveLength(3);
    expect(surface.calls).toContain("append:stream2:summary,c41");
    expect(surface.calls).toContain("append:stream3:summary,c80");
    expect(surface.calls).toContain("stop:stream1");
    expect(surface.streams.get("stream3")?.cards.has("c100")).toBe(true);
    expect(surface.streams.get("stream3")?.cards.get("summary")?.details).toBe(
      "79 steps so far",
    );
  });

  test("updating a card that exists is not a new card", async () => {
    const surface = fakeSurface({ maxCards: 12, rollAt: 10 });
    const { runStep } = stepper();
    const report = createReporter(
      { main: surface.channel },
      undefined,
      runStep,
    );

    for (let round = 0; round < 5; round++) {
      for (let i = 1; i <= 3; i++) {
        await report.card({
          id: `c${i}`,
          title: "t",
          status: round === 4 ? "done" : "running",
        });
      }
    }

    expect(surface.streams.size).toBe(1);
  });

  test("a stream the surface ended starts a new one with only the card at hand", async () => {
    const surface = fakeSurface({ endAfterWrites: 3 });
    const { runStep } = stepper();
    const report = createReporter(
      { main: surface.channel },
      undefined,
      runStep,
    );

    for (let i = 1; i <= 5; i++) {
      await report.card({ id: `c${i}`, title: `Step ${i}` });
    }

    expect(surface.calls).toEqual([
      "start:stream1",
      "append:stream1:c1",
      "append:stream1:c2",
      "append:stream1:c3",
      "start:stream2",
      "append:stream2:summary,c4",
      "stop:stream1",
      "append:stream2:c5",
    ]);
  });

  test("a stream that has lived as long as the surface allows is replaced", async () => {
    vi.useFakeTimers();

    try {
      const surface = fakeSurface({ maxAgeMs: 60_000 });
      const { runStep } = stepper();
      const report = createReporter(
        { main: surface.channel },
        undefined,
        runStep,
      );

      await report.card({ id: "a", title: "A" });
      vi.advanceTimersByTime(61_000);
      await report.card({ id: "b", title: "B" });

      expect(surface.streams.size).toBe(2);
      expect(surface.calls).toContain("append:stream2:summary,b");
    } finally {
      vi.useRealTimers();
    }
  });

  test("writes run one after another in call order, whatever they race", async () => {
    const surface = fakeSurface();
    const order: string[] = [];
    const { runStep } = stepper();
    const slow = defineChannel({
      post: async () => {},
      stream: {
        ...(surface.channel.stream as NonNullable<
          typeof surface.channel.stream
        >),
        append: async (id, cards) => {
          order.push(`begin:${cards[0]?.id}`);
          await new Promise((resolve) =>
            setTimeout(resolve, cards[0]?.id === "a" ? 30 : 0),
          );
          order.push(`end:${cards[0]?.id}`);
          await surface.channel.stream?.append(id, cards);
        },
      },
    });
    const report = createReporter({ main: slow }, undefined, runStep);

    await Promise.all([
      report.card({ id: "a", title: "A" }),
      report.card({ id: "b", title: "B" }),
      report.card({ id: "c", title: "C" }),
    ]);

    // The first card opens the stream, so only the appends after it are seen.
    expect(order).toEqual([
      "begin:a",
      "end:a",
      "begin:b",
      "end:b",
      "begin:c",
      "end:c",
    ]);
  });

  test("a replay writes nothing again and continues from the saved stream state", async () => {
    const surface = fakeSurface();
    const first = stepper();
    const report = createReporter(
      { main: surface.channel },
      undefined,
      first.runStep,
    );

    await report.card({ id: "a", title: "A" });
    await report.card({ id: "b", title: "B" });

    const callsBefore = [...surface.calls];
    const again = stepper(first.results);
    const replay = createReporter(
      { main: surface.channel },
      undefined,
      again.runStep,
    );

    await replay.card({ id: "a", title: "A" });
    await replay.card({ id: "b", title: "B" });
    expect(surface.calls).toEqual(callsBefore);

    await replay.card({ id: "c", title: "C" });
    expect(surface.calls.at(-1)).toBe("append:stream1:c");
    expect(again.ran).toEqual(["report:card:3:0:main"]);
  });

  test("a card updated after its stream was left shows in the current stream", async () => {
    const surface = fakeSurface({ maxCards: 12, rollAt: 3 });
    const { runStep } = stepper();
    const report = createReporter(
      { main: surface.channel },
      undefined,
      runStep,
    );

    for (const id of ["a", "b", "c", "d"]) {
      await report.card({ id, title: id });
    }

    await report.card({ id: "a", title: "a", status: "done" });

    expect(surface.calls.at(-1)).toBe("append:stream2:a");
  });

  test("a rollover whose first write fails closes the stream it started", async () => {
    const calls: string[] = [];
    const channel = defineChannel({
      post: async () => {},
      stream: {
        limits: { maxCards: 50, rollAt: 40, maxAgeMs: 60_000 },
        start: async () => {
          calls.push("start");

          return "s";
        },
        append: async () => {
          throw new Error("boom");
        },
        stop: async () => {
          calls.push("stop");
        },
      },
    });
    const report = createReporter(
      { main: channel },
      undefined,
      stepper().runStep,
    );

    await expect(report.card({ id: "a", title: "A" })).rejects.toThrow("boom");
    expect(calls).toEqual(["start", "stop"]);
  });

  test("two lists of destinations share one stream per channel", async () => {
    const one = fakeSurface();
    const two = fakeSurface();
    const report = createReporter(
      { a: one.channel, b: two.channel },
      undefined,
      stepper().runStep,
    );

    await report.card({ id: "x", title: "X" }, { to: ["a", "b"] });
    await report.card({ id: "y", title: "Y" }, { to: "b" });

    expect(two.streams.size).toBe(1);
    expect(one.streams.size).toBe(1);
  });

  test("a failure of one write does not stop the next from running", async () => {
    const calls: string[] = [];
    let failFirst = true;
    const channel = defineChannel({
      post: async () => {},
      stream: {
        limits: { maxCards: 50, rollAt: 40, maxAgeMs: 60_000 },
        start: async () => "s",
        append: async (_id, cards) => {
          if (failFirst) {
            failFirst = false;
            throw new Error("boom");
          }

          calls.push(cards[0]?.id ?? "");
        },
      },
    });
    const report = createReporter(
      { main: channel },
      undefined,
      stepper().runStep,
    );
    const first = report.card({ id: "a", title: "A" });
    const second = report.card({ id: "b", title: "B" });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(calls).toEqual(["b"]);
  });

  test("a channel with no stream ignores cards, and a bad card is refused", async () => {
    const posted: string[] = [];
    const plain = defineChannel({
      post: async (m) => {
        posted.push(m.text);
      },
    });
    const { runStep, ran } = stepper();
    const report = createReporter({ main: plain }, undefined, runStep);

    await report.card({ id: "a", title: "A" });
    expect(ran).toEqual([]);
    expect(posted).toEqual([]);

    await expect(report.card({ id: "summary", title: "x" })).rejects.toThrow(
      "summary",
    );
    await expect(report.card({ id: "", title: "x" })).rejects.toThrow(
      "id of 1 to 100",
    );
    await expect(report.card({ id: "a", title: "" })).rejects.toThrow(
      "needs a title",
    );
    await expect(
      report.card({ id: "a", title: "x", status: "weird" as never }),
    ).rejects.toThrow("a status of");
  });

  test("stream limits an adapter declares must leave room for the summary", () => {
    const stream = {
      start: async () => "s",
      append: async () => {},
    };

    expect(() => {
      return defineChannel({
        post: async () => {},
        stream: {
          ...stream,
          limits: { maxCards: 50, rollAt: 49, maxAgeMs: 1 },
        },
      });
    }).toThrow("rollAt");
  });
});

describe("the Slack stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const slackChannel = () => {
    return slack.channel(
      { channel: "C1", threadTs: "1.1" },
      { in: ["C1"], token: "t", user: "U1", team: "T1" },
    );
  };

  const stubSlack = (
    answer: (
      method: string,
      body: Record<string, unknown>,
    ) => Record<string, unknown>,
  ) => {
    const sent: { method: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const method = String(url).split("/").at(-1) as string;
      const body = JSON.parse(init.body) as Record<string, unknown>;

      sent.push({ method, body });

      return new Response(JSON.stringify(answer(method, body)), {
        status: 200,
      });
    });

    return sent;
  };

  test("limits are the surface's: 50 cards, roll at 40, under ten minutes", () => {
    expect(slackChannel().stream?.limits).toEqual({
      maxCards: 50,
      rollAt: 40,
      maxAgeMs: 540_000,
    });
  });

  test("cards go out as escaped task_update chunks of the thread's stream", async () => {
    const sent = stubSlack((method) => {
      return method === "chat.startStream"
        ? { ok: true, ts: "9.9" }
        : { ok: true };
    });
    const stream = slackChannel().stream;
    const id = await stream?.start();

    await stream?.append(id as string, [
      {
        id: "c1",
        title: "<!channel> build",
        status: "done",
        details: "ok & done",
      },
    ]);

    expect(sent[0]).toMatchObject({
      method: "chat.startStream",
      body: { channel: "C1", thread_ts: "1.1" },
    });
    expect(sent[1]).toMatchObject({
      method: "chat.appendStream",
      body: {
        channel: "C1",
        ts: "9.9",
        chunks: [
          {
            type: "task_update",
            id: "c1",
            title: "&lt;!channel&gt; build",
            status: "complete",
            details: "ok &amp; done",
          },
        ],
      },
    });
  });

  test("a warning on a streamed update is an error, not a success", async () => {
    stubSlack((method) => {
      return method === "chat.appendStream"
        ? {
            ok: true,
            warning: "missing_charset",
            response_metadata: {
              warnings: ["missing_charset"],
              messages: ["[WARN] Maximum unique tasks (50) reached"],
            },
          }
        : { ok: true, ts: "9.9" };
    });

    await expect(
      slackChannel().stream?.append("9.9", [{ id: "c1", title: "t" }]),
    ).rejects.toThrow(
      "dropped part of the update: [WARN] Maximum unique tasks",
    );
  });

  test("Slack's harmless notices on a streamed update are not errors", async () => {
    stubSlack(() => {
      return {
        ok: true,
        ts: "9.9",
        warning: "missing_charset",
        response_metadata: { warnings: ["missing_charset"] },
      };
    });

    await expect(
      slackChannel().stream?.append("9.9", [{ id: "c1", title: "t" }]),
    ).resolves.toBeUndefined();
  });

  test("a stream starts for a user and a team, as a plan", async () => {
    const sent = stubSlack(() => {
      return { ok: true, ts: "9.9" };
    });

    await slackChannel().stream?.start();

    expect(sent[0]).toMatchObject({
      method: "chat.startStream",
      body: {
        channel: "C1",
        thread_ts: "1.1",
        recipient_user_id: "U1",
        recipient_team_id: "T1",
        task_display_mode: "plan",
        chunks: [{ type: "plan_update", title: "Progress" }],
      },
    });
  });

  test("the user comes from the event, the team from auth.test, and a stream without a user is refused", async () => {
    const sent = stubSlack((method) => {
      return method === "auth.test"
        ? { ok: true, team_id: "T9" }
        : { ok: true, ts: "9.9" };
    });
    const fromEvent = slack.channel(
      { data: { channel: "C1", ts: "1.1", text: "hi", user: "U7" } },
      { in: ["C1"], token: "t" },
    );

    await fromEvent.stream?.start();

    expect(sent[0]?.method).toBe("auth.test");
    expect(sent[1]?.body).toMatchObject({
      recipient_user_id: "U7",
      recipient_team_id: "T9",
    });

    const noUser = slack.channel(
      { channel: "C1", threadTs: "1.1" },
      { in: ["C1"], token: "t", team: "T1" },
    );

    await expect(noUser.stream?.start()).rejects.toThrow("needs the user");
  });

  test("a gone message is only a stream that ended for the stream calls", async () => {
    stubSlack(() => {
      return { ok: false, error: "message_not_found" };
    });

    await expect(
      slackChannel().post({ text: "hi" }),
    ).rejects.not.toBeInstanceOf(ChannelStreamEnded);
  });

  test("long card text is cut without leaving half an entity", async () => {
    const sent = stubSlack(() => {
      return { ok: true };
    });

    await slackChannel().stream?.append("9.9", [
      { id: "c1", title: "&".repeat(300) },
    ]);

    const title = (sent[0]?.body.chunks as { title: string }[])[0]
      ?.title as string;

    expect(title.length).toBeLessThanOrEqual(250);
    expect(title).toMatch(/(&amp;)+…$/);
  });

  test("a message that is gone is a stream that ended", async () => {
    for (const error of [
      "message_not_in_streaming_state",
      "message_not_found",
      "cant_update_message",
    ]) {
      stubSlack(() => {
        return { ok: false, error };
      });

      await expect(
        slackChannel().stream?.append("9.9", [{ id: "c1", title: "t" }]),
      ).rejects.toBeInstanceOf(ChannelStreamEnded);
    }
  });

  test("message_not_in_streaming_state is a stream that ended, and the reporter starts another", async () => {
    let started = 0;
    let firstAppends = 0;
    const sent = stubSlack((method, body) => {
      if (method === "chat.startStream") {
        return { ok: true, ts: `9.${++started}` };
      }

      // The first stream takes one card, then Slack ends it.
      if (method === "chat.appendStream" && body.ts === "9.1") {
        firstAppends += 1;

        if (firstAppends > 1) {
          return { ok: false, error: "message_not_in_streaming_state" };
        }
      }

      return { ok: true };
    });
    const report = createReporter(
      { main: slackChannel() },
      undefined,
      stepper().runStep,
    );

    await report.card({ id: "c1", title: "t" });
    await report.card({ id: "c2", title: "t" });

    const appends = sent.filter((s) => s.method === "chat.appendStream");

    // c1 lands; c2 finds the stream over (the failed write), then lands on a new one.
    expect(appends.map((s) => s.body.ts)).toEqual(["9.1", "9.1", "9.2"]);
    expect(
      (appends[2]?.body.chunks as { id: string }[]).map((c) => c.id),
    ).toEqual(["summary", "c2"]);
  });
});

describe("report.status and the Slack status line", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a status goes to the channels that have one, in order with cards, and a replay shows nothing twice", async () => {
    const shown: string[] = [];
    const withStatus = defineChannel({
      post: async () => {},
      status: async (status) => {
        shown.push(status);
      },
    });
    const plain = defineChannel({ post: async () => {} });
    const first = stepper();
    const report = createReporter(
      { a: withStatus, b: plain },
      ["a", "b"],
      first.runStep,
    );

    await report.status("working");
    await report.status("idle");
    expect(shown).toEqual(["working", "idle"]);
    expect(first.ran).toEqual(["report:status:1:0:a", "report:status:2:0:a"]);

    const again = stepper(first.results);
    const replay = createReporter({ a: withStatus }, ["a"], again.runStep);

    await replay.status("working");
    await replay.status("idle");
    expect(shown).toEqual(["working", "idle"]);
    expect(again.ran).toEqual([]);
  });

  test("a status that throws never fails the run, and a bad destination or status rejects", async () => {
    const throwing = defineChannel({
      post: async () => {},
      status: async () => {
        throw new Error("no status for you");
      },
    });
    const report = createReporter(
      { main: throwing },
      undefined,
      stepper().runStep,
    );

    await expect(report.status("working")).resolves.toBeUndefined();
    await expect(report.status("working", { to: "nope" })).rejects.toThrow(
      "no channel named",
    );
    await expect(report.status("busy" as never)).rejects.toThrow(
      "the status is one of",
    );
  });

  test("a card's output and sources are checked", async () => {
    const report = createReporter({}, undefined, stepper().runStep);

    await expect(
      report.card({ id: "a", title: "A", output: 1 as never }),
    ).rejects.toThrow("details and output are text");
    await expect(
      report.card({
        id: "a",
        title: "A",
        sources: [{ url: "", text: "x" }],
      }),
    ).rejects.toThrow("sources are up to");
    await expect(
      report.card({
        id: "a",
        title: "A",
        sources: Array.from({ length: 21 }, () => {
          return { url: "https://x.test", text: "x" };
        }),
      }),
    ).rejects.toThrow("sources are up to");
  });

  test("a channel's status must be a function", () => {
    expect(() => {
      return defineChannel({ post: async () => {}, status: 1 as never });
    }).toThrow("status");
  });

  const stubCalls = (answer: (method: string) => Record<string, unknown>) => {
    const sent: { method: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const method = String(url).split("/").at(-1) as string;

      sent.push({ method, body: JSON.parse(init.body) });

      return new Response(JSON.stringify(answer(method)), { status: 200 });
    });

    return sent;
  };

  const channel = () => {
    return slack.channel(
      { channel: "C1", threadTs: "1.1" },
      { in: ["C1"], token: "t", user: "U1", team: "T1" },
    );
  };

  test("Slack shows the status with the agents API", async () => {
    const sent = stubCalls(() => {
      return { ok: true };
    });

    await channel().status?.("working");
    await channel().status?.("idle");
    await channel().status?.("waiting");

    expect(
      sent.map((s) => {
        return [s.method, s.body.status];
      }),
    ).toEqual([
      ["agents.sessions.setStatus", "processing"],
      ["agents.sessions.setStatus", "active"],
      ["agents.sessions.setStatus", "suspended"],
    ]);
    expect(sent[0]?.body).toMatchObject({ channel_id: "C1", thread_ts: "1.1" });
  });

  test("it falls back to the assistant thread status, and shows none if that fails too", async () => {
    const sent = stubCalls((method) => {
      return method === "agents.sessions.setStatus"
        ? { ok: false, error: "not_allowed_token_type" }
        : { ok: true };
    });

    await channel().status?.("working");
    await channel().status?.("idle");

    expect(
      sent.map((s) => {
        return [s.method, s.body.status];
      }),
    ).toEqual([
      ["agents.sessions.setStatus", "processing"],
      ["assistant.threads.setStatus", "is working..."],
      ["agents.sessions.setStatus", "active"],
      ["assistant.threads.setStatus", ""],
    ]);

    stubCalls(() => {
      return { ok: false, error: "channel_not_found" };
    });
    await expect(channel().status?.("working")).resolves.toBeUndefined();
  });

  test("a card's output and sources reach Slack as chunk fields", async () => {
    const sent = stubCalls(() => {
      return { ok: true };
    });

    await channel().stream?.append("9.9", [
      {
        id: "c1",
        title: "Read",
        output: "done & dusted",
        sources: [{ url: "https://x.test/a", text: "A <page>" }],
      },
    ]);

    expect((sent[0]?.body.chunks as unknown[])[0]).toMatchObject({
      output: "done &amp; dusted",
      sources: [
        { type: "url", url: "https://x.test/a", text: "A &lt;page&gt;" },
      ],
    });
  });
});
