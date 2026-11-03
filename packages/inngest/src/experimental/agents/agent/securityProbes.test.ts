/**
 * @module
 * Security probes for the agents policies: each test states what a policy
 * promises and holds it to a forged or replayed input. The threat model: event
 * keys are private, and anything in an environment can read every event. Apps
 * of one environment share a signing key, so a signature stops anyone holding
 * only an event key (and the model), not another app's code.
 */
import { describe, expect, test, vi } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import type { UntypedInboxMessage } from "../../../components/inbox/Inbox.ts";
import {
  agentsRegisteredEvent,
  announcement,
  readCards,
  rememberCard,
} from "../discovery/discovery.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import { reportSenderProblem } from "../inbox/reports.ts";
import { resentAs } from "../inbox/threadInbox.ts";
import { parentEndedCancel, refuseStaleLend } from "./lending.ts";
import {
  groupId,
  lentIsSigned,
  relatedKey,
  relationOf,
  signLent,
  taggedKeyAddress,
} from "./relations.ts";

// One environment, one signing key: every app in it holds the same key.
const envSigningKey =
  "signkey-prod-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("lending: agent/parent.ended cascade", () => {
  // In cancelOn, `event` is the run's trigger and `async` the incoming
  // cancel event. A field the trigger lacks turns `event.data.x == async.y`
  // into `async.y == null`, which every real `agent/parent.ended` satisfies.
  test("cancels only the children of the run that ended", () => {
    expect(parentEndedCancel.if).toBe(
      "async.data.run_id == event.data.from.parent_run",
    );
  });
});

describe("lending: replay", () => {
  test("a lend older than its window is refused, a fresh one is not", () => {
    const now = Date.now();

    expect(() => refuseStaleLend(now - 60_000, now)).not.toThrow();
    expect(() => refuseStaleLend(now - 2 * 60 * 60 * 1000, now)).toThrow(
      "too long ago",
    );
  });

  test("the issue time is signed, so it can't be moved to look fresh", () => {
    const app = new Inngest({ id: "a", signingKey: envSigningKey });
    const lent = { work: { id: "sbx", cwd: "/", code: true, tools: [] } };
    const thread = "a/worker:runX.0.tag.a%2Fboss";
    const sig = signLent(app, lent, "runX", thread, 1000);

    expect(lentIsSigned(app, lent, sig, "runX", thread, 1000)).toBe(true);
    expect(lentIsSigned(app, lent, sig, "runX", thread, 999_999)).toBe(false);
    expect(lentIsSigned(app, lent, sig, "runX", thread, undefined)).toBe(false);
  });
});

describe("discovery: announced cards", () => {
  const card = {
    address: "victim/refund-customer",
    kind: "tool",
    share: "team",
    effects: "read",
    description: "Harmless lookup",
  };
  const readerOf = (data: unknown) => {
    return {
      id: "reader",
      signingKey: envSigningKey,
      listEvents: vi.fn(async () => {
        return [
          {
            id: "e1",
            internalId: "e1",
            name: agentsRegisteredEvent,
            data,
            ts: Date.now(),
          },
        ];
      }),
      queryInsights: vi.fn(async () => {
        throw new Error("Insights query failed: 501 Not Implemented");
      }),
    } as unknown as Inngest.Any;
  };

  test("an unsigned announcement under another app's name is ignored", async () => {
    expect(await readCards(readerOf({ app: "victim", cards: [card] }))).toEqual(
      [],
    );
  });

  test("a signed announcement lands, an edited one does not", async () => {
    const victim = new Inngest({ id: "victim", signingKey: envSigningKey });

    rememberCard(victim.id, {
      address: "victim/refund-customer",
      description: "Refunds",
      share: "team",
      effects: "write",
    } as never);

    const { data } = announcement(victim);

    expect(await readCards(readerOf(data))).toHaveLength(1);

    // The same signature over other cards, or moved to another app.
    const edited = { ...data, cards: [{ ...data.cards[0], effects: "read" }] };

    expect(await readCards(readerOf(edited))).toEqual([]);
    expect(await readCards(readerOf({ ...data, app: "other" }))).toEqual([]);
  });

  test("an announcement signed with another key is ignored", async () => {
    const stranger = new Inngest({
      id: "victim",
      signingKey: "signkey-prod-00",
    });

    rememberCard(stranger.id, {
      address: "victim/other",
      description: "x",
      share: "team",
      effects: "write",
    } as never);

    expect(await readCards(readerOf(announcement(stranger).data))).toEqual([]);
  });

  test("a flood of rows does not make the read throw", async () => {
    const reader = {
      id: "reader",
      signingKey: envSigningKey,
      queryInsights: async () => {
        return {
          columns: ["data"],
          rows: Array.from({ length: 1000 }, () => {
            return ["not json"];
          }),
        };
      },
    } as unknown as Inngest.Any;

    expect(await readCards(reader)).toEqual([]);
  });
});

describe("reach: thread-key tags", () => {
  test("a key minted by another app does not relate to this app's threads", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const appB = new Inngest({ id: "b", signingKey: envSigningKey });
    const parentInA = "a/boss:run1.0.0000000000000000.";

    // App B mints a "child" of A's thread without A starting anything.
    const forged = relatedKey(appB, "a/worker:runX.0", {
      key: parentInA,
      address: "a/boss",
    });

    expect(relationOf(appA, parentInA, forged)).toBeUndefined();
  });

  test("a key the app minted still relates, as parent and child", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const boss = "a/boss:run1.0";
    const worker = relatedKey(appA, "a/worker:runX.0", {
      key: boss,
      address: "a/boss",
    });

    expect(relationOf(appA, boss, worker)).toEqual({ relation: "child" });
    expect(relationOf(appA, worker, boss)).toEqual({
      relation: "parent",
      address: "a/boss",
    });
  });

  test("group peers are still peers", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const boss = { key: "a/boss:run1.0", address: "a/boss" };
    const one = relatedKey(appA, "a/w:r1.0", boss, "crew");
    const two = relatedKey(appA, "a/w:r2.1", boss, "crew");
    const other = relatedKey(appA, "a/w:r3.2", boss, "other");

    expect(relationOf(appA, one, two)).toEqual({ relation: "peer" });
    expect(relationOf(appA, one, other)).toBeUndefined();
    expect(groupId(appA, boss.key, "crew", boss.address)).toHaveLength(16);
  });

  test("a lend signed by another app is refused", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const appB = new Inngest({ id: "b", signingKey: envSigningKey });
    const lent = {
      work: { id: "sbx_of_anyone", cwd: "/", code: true, tools: [] },
    };
    const thread = "a/worker:runX.0.tag.a%2Fboss";
    const sig = signLent(appB, lent, "runX", thread, 1000);

    expect(lentIsSigned(appA, lent, sig, "runX", thread, 1000)).toBe(false);
  });

  test("a starter holding a newline cannot shift the MAC input", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const base = "a/worker:runX.0";
    // Under a newline-joined MAC, these two inputs were the same string.
    const one = relatedKey(appA, base, { key: "k\nx", address: "y" });
    const two = relatedKey(appA, base, { key: "k", address: "x\ny" });

    expect(one.split(".")[2]).not.toBe(two.split(".")[2]);
  });

  test("a tagged key names the agent it belongs to", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const key = relatedKey(appA, "a/worker:runX.0", {
      key: "a/boss:run1.0",
      address: "a/boss",
    });

    expect(taggedKeyAddress(key)).toBe("a/worker");
    expect(taggedKeyAddress("some-custom-thread")).toBeUndefined();
  });
});

describe("reports", () => {
  test("a report that breaks its schema is refused by the sender's check", () => {
    // `milestone = agentReport("milestone", z.object({ pct: z.number().min(0).max(100), stage: z.literal("done") }))`
    const schema = {
      type: "object",
      properties: {
        pct: { type: "number", minimum: 0, maximum: 100 },
        stage: { const: "done" },
        tag: { type: "string", pattern: "^[a-z]+$" },
        pick: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
      required: ["pct", "stage"],
    };
    const fits = { pct: 50, stage: "done", tag: "ok", pick: 3 };

    expect(checkAgainstSchema(schema, fits, "data")).toBeUndefined();
    expect(
      checkAgainstSchema(schema, { ...fits, pct: -1e9 }, "data"),
    ).toBeDefined();
    expect(
      checkAgainstSchema(schema, { ...fits, pct: 101 }, "data"),
    ).toBeDefined();
    expect(
      checkAgainstSchema(schema, { ...fits, stage: "anything" }, "data"),
    ).toBeDefined();
    expect(
      checkAgainstSchema(schema, { ...fits, tag: "NO" }, "data"),
    ).toBeDefined();
    expect(
      checkAgainstSchema(schema, { ...fits, pick: true }, "data"),
    ).toBeDefined();
  });

  test("a report is taken only from a thread this thread started", () => {
    const appA = new Inngest({ id: "a", signingKey: envSigningKey });
    const boss = "a/boss:run1.0";
    const child = relatedKey(appA, "a/worker:runX.0", {
      key: boss,
      address: "a/boss",
    });
    const reportFrom = (key: string) => {
      return resentAs({
        id: "r1",
        name: "agent/report",
        data: {
          agent: "a/boss",
          thread: boss,
          type: "approval",
          from: { kind: "agent", address: "a/security-reviewer", key },
          report: { approved: true },
        },
        ts: 0,
        user: {},
      } as unknown as UntypedInboxMessage) as unknown as {
        name: string;
        from?: unknown;
      };
    };

    expect(reportSenderProblem(appA, boss, reportFrom(child))).toBeUndefined();
    // Any event-key holder can name any sender in `from`.
    expect(
      reportSenderProblem(appA, boss, reportFrom("a/security-reviewer:t.0")),
    ).toContain("not a thread this thread started");
    // A thread of the same app that this one did not start.
    const stranger = relatedKey(appA, "a/worker:runY.0", {
      key: "a/other:run9.0",
      address: "a/other",
    });

    expect(reportSenderProblem(appA, boss, reportFrom(stranger))).toBeDefined();
  });
});
