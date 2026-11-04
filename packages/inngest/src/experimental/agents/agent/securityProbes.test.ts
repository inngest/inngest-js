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
import {
  attenuate,
  lendDigest,
  messageGrantProblem,
  mintGrant,
  parentLine,
  proofOf,
  renewalFor,
  renewedUntil,
  routeLine,
  startGrantOf,
  toWire,
  verifyGrant,
} from "./grant.ts";
import { lendOf, parentEndedCancel } from "./lending.ts";
import {
  fullMac,
  groupId,
  relatedKey,
  relationOf,
  taggedKeyAddress,
} from "./relations.ts";

// One environment, one signing key: every app in it holds the same key.
const envSigningKey =
  "signkey-prod-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("lending: agent/parent.ended cascade", () => {
  // In cancelOn, `event` is the run's trigger and `async` the incoming
  // cancel event. A field the trigger lacks turns `event.data.x == async.y`
  // into `async.y == null`, which every real `agent/parent.ended` satisfies.
  test("cancels only the children of the run that ended, recovered ones too", () => {
    expect(parentEndedCancel.if).toContain("async.data.run_id == (");
    expect(parentEndedCancel.if).toContain("event.data.from.parent_run");
    expect(parentEndedCancel.if).toContain(
      "event.data.event.data.from.parent_run",
    );
  });
});

describe("lending: replay", () => {
  test("a lend is bound to its run, thread and app by the grant, and has no clock", () => {
    const app = new Inngest({ id: "a", signingKey: envSigningKey });
    const other = new Inngest({ id: "b", signingKey: envSigningKey });
    const lent = { work: { id: "sbx", cwd: "/", code: true, tools: [] } };
    const thread = "a/worker:runX.0.tag.a%2Fboss";
    const grant = (run: string | undefined, over = thread) => {
      return mintGrant(app, {
        thread: over,
        lines: [
          "iss=a",
          ...(run ? [`run=${run}`] : []),
          `lend=${lendDigest(lent)}`,
        ],
      });
    };
    const start = { name: "agent/message", data: { from: { lent } } };

    expect(lendOf(app, start, thread, grant("runX"))?.parentRun).toBe("runX");
    expect(() => lendOf(app, start, thread, grant(undefined))).toThrow();
    expect(() =>
      lendOf(app, start, "a/worker:runX.1", grant("runX")),
    ).toThrow();
    expect(() =>
      lendOf(
        app,
        {
          name: "agent/message",
          data: { from: { lent: { work: { id: "x" } } } },
        },
        thread,
        grant("runX"),
      ),
    ).toThrow();
    // A grant of another app of the environment lends nothing to this app.
    expect(() => lendOf(other, start, thread, grant("runX"))).toThrow();
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

describe("grants", () => {
  const appA = new Inngest({ id: "a", signingKey: envSigningKey });
  const boss = "a/boss:run1.0";
  const ledger = "a/ledger:run2.0";
  // A child started with a thread key of its own: no tag relates it.
  const child = "custom-child-key";
  const at = 1_700_000_000;
  const make = (extra: string[] = []) => {
    return mintGrant(appA, {
      thread: child,
      restrict: ["depth=1", 'start=[{"effects":"read"}]'],
      lines: [
        "iss=a",
        `iat=${at}`,
        `until=${at + 7 * 86400}`,
        parentLine("a/boss", boss),
        routeLine({ type: "milestone", agent: "a/boss", thread: boss }),
        routeLine({ type: "milestone", agent: "a/ledger", thread: ledger }),
        ...extra,
      ],
    });
  };
  const grant = make();
  const startOf = (
    given = grant,
    over: { id?: string; thread?: string } = {},
  ) => {
    const id = over.id ?? "msg:run1.0";
    const thread = over.thread ?? child;

    return {
      id,
      name: "agent/message",
      ts: (at + 60) * 1000,
      data: {
        agent: "a/child",
        thread,
        content: "go",
        from: { kind: "agent", address: "a/boss", key: boss, thread },
        "::agents": proofOf(appA, given, id, thread),
      },
    };
  };

  test("a grant is a few readable lines and a signature, typically 300 to 500 bytes", () => {
    const wire = toWire(grant);
    const size = JSON.stringify(wire).length;

    expect(wire.lines[0]).toBe("depth=1");
    expect(wire.lines).toContain("sub");
    expect(size).toBeLessThan(700);
  });

  test("a start that carries a valid grant yields its limits, routes and starter", () => {
    const got = startGrantOf(appA, startOf(), child);

    expect(got?.limits.depth).toBe(1);
    expect(got?.limits.discovery?.agents).toEqual([[{ effects: "read" }]]);
    expect(got?.par).toEqual({ address: "a/boss", key: boss });
    expect(got?.rep).toHaveLength(2);
  });

  test("a forged start that drops the inherited limits is refused", () => {
    const real = startOf();
    const without = (edit: (lines: string[]) => string[]) => {
      const data = real.data as {
        "::agents": { grant: { lines: string[]; sig: string } };
      };

      return {
        ...real,
        data: {
          ...real.data,
          "::agents": {
            ...data["::agents"],
            grant: {
              ...data["::agents"].grant,
              lines: edit(data["::agents"].grant.lines),
            },
          },
        },
      };
    };

    // The grant is taken off: the start still says an agent started it.
    const { "::agents": _grant, ...bare } = real.data;

    expect(() => startGrantOf(appA, { ...real, data: bare }, child)).toThrow(
      "no grant",
    );
    // The limit lines are cut out, the signature kept.
    expect(() =>
      startGrantOf(
        appA,
        without((lines) =>
          lines.filter((line) => !/^(depth|start)=/.test(line)),
        ),
        child,
      ),
    ).toThrow("does not verify");
    // A limit line is made wider.
    expect(() =>
      startGrantOf(
        appA,
        without((lines) =>
          lines.map((line) => (line === "depth=1" ? "depth=9" : line)),
        ),
        child,
      ),
    ).toThrow("does not verify");
    // Limits written in the old, unsigned place are not taken.
    expect(() =>
      startGrantOf(
        appA,
        {
          id: "e",
          name: "agent/message",
          data: { from: { thread: child, limits: { depth: 9 } } },
        },
        child,
      ),
    ).toThrow("no grant");
    // A grant signed with another key.
    const foreign = new Inngest({ id: "a", signingKey: "signkey-prod-ffff" });

    expect(verifyGrant(foreign, toWire(grant), child)).toBeUndefined();
  });

  test("a grant made for one thread is refused by another", () => {
    expect(() =>
      startGrantOf(appA, startOf(grant, { thread: "other" }), "other"),
    ).toThrow("does not verify");
  });

  test("a child cannot widen a grant", () => {
    expect(attenuate(grant, ["depth=0"]).limits.depth).toBe(0);
    // A larger depth added later does not raise it: the lowest wins.
    expect(attenuate(grant, ["depth=5"]).limits.depth).toBe(1);
    // A further list only adds a condition.
    expect(
      attenuate(grant, ['start=[{"app":"a"}]']).limits.discovery?.agents,
    ).toHaveLength(2);
    // A line that grants cannot be added without the signing key.
    expect(() =>
      attenuate(grant, [
        routeLine({ type: "milestone", agent: "a/evil", thread: "t" }),
      ]),
    ).toThrow();

    // Nor by chaining one by hand, as a holder without the key would.
    const line = routeLine({ type: "milestone", agent: "a/evil", thread: "t" });
    const forged = {
      lines: [...toWire(grant).lines, line],
      sig: fullMac(grant.sig, line).slice(0, 32),
    };

    expect(verifyGrant(appA, forged, child)).toBeUndefined();
    // Nor a block that names the attacker as holder.
    const sub = "sub=attacker";
    const taken = {
      lines: [
        ...grant.lines,
        sub,
        "iss=a",
        routeLine({ type: "milestone", agent: "a/evil", thread: "attacker" }),
      ],
      sig: fullMac(grant.sig, sub).slice(0, 32),
    };

    expect(verifyGrant(appA, taken, "attacker")).toBeUndefined();
    // Removing a line is no better.
    expect(
      verifyGrant(
        appA,
        { lines: toWire(grant).lines.slice(1), sig: grant.sig },
        child,
      ),
    ).toBeUndefined();
  });

  test("a copied grant on another message is refused", () => {
    const message = (
      id: string,
      target: string,
      from = child,
      given = grant,
    ) => {
      return {
        id,
        ts: (at + 60) * 1000,
        data: {
          from: { kind: "agent", key: from },
          "::agents": proofOf(appA, given, id, target),
        },
      };
    };
    const real = message("msg:run9.0", boss);
    const data = real.data as { "::agents": { grant: unknown; pop: string } };

    expect(messageGrantProblem(appA, real, boss)).toBeUndefined();
    // The same grant and proof on another event ID.
    expect(
      messageGrantProblem(appA, { ...real, id: "msg:run9.1" }, boss),
    ).toBeDefined();
    // The same grant and proof sent to another thread.
    expect(messageGrantProblem(appA, real, ledger)).toBeDefined();
    // A reader who copied the grant and signature cannot make the proof.
    expect(
      messageGrantProblem(
        appA,
        {
          id: "msg:other",
          ts: real.ts,
          data: {
            from: { kind: "agent", key: child },
            "::agents": { grant: data["::agents"].grant, pop: "0".repeat(32) },
          },
        },
        boss,
      ),
    ).toBeDefined();
    // Sent as another thread: the grant names the child as holder.
    expect(
      messageGrantProblem(
        appA,
        {
          ...real,
          data: { ...real.data, from: { kind: "agent", key: "thief" } },
        },
        boss,
      ),
    ).toBeDefined();
    // A message with no grant is a plain message.
    expect(
      messageGrantProblem(
        appA,
        { id: "m", data: { from: { key: child } } },
        boss,
      ),
    ).toBeUndefined();
  });

  test("an unattached child's grant ends after 7 days and its starter renews it", () => {
    const late = (at + 8 * 86400) * 1000;
    const message = (id: string, ts: number, renew?: object) => {
      return {
        id,
        ts,
        data: {
          from: { kind: "agent", key: child },
          "::agents": {
            ...proofOf(appA, grant, id, boss),
            ...(renew && { renew }),
          },
        },
      };
    };

    expect(messageGrantProblem(appA, message("m1", late), boss)).toContain(
      "expired",
    );

    const until = at + 15 * 86400;
    const renewal = renewalFor(appA, child, boss, until);

    expect(renewedUntil(appA, grant, renewal, boss)).toBe(until);
    expect(
      messageGrantProblem(appA, message("m2", late, renewal), boss),
    ).toBeUndefined();
    // Only the starter's renewal counts: not another thread's, not an edited one.
    expect(
      renewedUntil(
        appA,
        grant,
        renewalFor(appA, child, "thief", until),
        "thief",
      ),
    ).toBeUndefined();
    expect(
      renewedUntil(appA, grant, { ...renewal, until: until + 1 }, boss),
    ).toBeUndefined();
    expect(renewedUntil(appA, grant, renewal, "thief")).toBeUndefined();
    expect(
      messageGrantProblem(
        appA,
        message("m3", late, { ...renewal, until: until + 1 }),
        boss,
      ),
    ).toContain("expired");
    // An attached child has no end of its own: it ends with its parent's run.
    expect(
      messageGrantProblem(
        appA,
        {
          id: "m4",
          ts: late,
          data: {
            from: { kind: "agent", key: child },
            "::agents": proofOf(
              appA,
              mintGrant(appA, { thread: child, lines: ["iss=a", "run=run1"] }),
              "m4",
              boss,
            ),
          },
        },
        boss,
      ),
    ).toBeUndefined();
  });
});

describe("reports: grants", () => {
  const appA = new Inngest({ id: "a", signingKey: envSigningKey });
  const boss = "a/boss:run1.0";
  const ledger = "a/ledger:run2.0";
  // A custom key: only the grant relates the child to the report's receivers.
  const child = "custom-child-key";
  const grant = mintGrant(appA, {
    thread: child,
    lines: [
      "iss=a",
      parentLine("a/boss", boss),
      routeLine({ type: "milestone", agent: "a/boss", thread: boss }),
      routeLine({ type: "milestone", agent: "a/ledger", thread: ledger }),
    ],
  });
  const sent = (
    to: string,
    over: {
      name?: string;
      id?: string;
      from?: string;
      given?: typeof grant;
    } = {},
  ) => {
    const id = over.id ?? "report:run3.0.0";

    return {
      id,
      name: over.name ?? "milestone",
      from: { kind: "agent", key: over.from ?? child },
      report: proofOf(appA, over.given ?? grant, id, to),
    };
  };

  test("a destination the grant names takes the child's report", () => {
    expect(reportSenderProblem(appA, boss, sent(boss))).toBeUndefined();
    expect(reportSenderProblem(appA, ledger, sent(ledger))).toBeUndefined();
  });

  test("a thread the grant does not name still drops it", () => {
    expect(
      reportSenderProblem(appA, "a/other:run3.0", sent("a/other:run3.0")),
    ).toBeDefined();
    expect(
      reportSenderProblem(appA, ledger, sent(ledger, { name: "other" })),
    ).toBeDefined();
  });

  test("a copied or forged grant drops it", () => {
    // The report meant for the boss, resent to the ledger.
    expect(
      reportSenderProblem(appA, ledger, {
        ...sent(boss),
        id: "report:run3.0.0",
      }),
    ).toBeDefined();
    expect(
      reportSenderProblem(appA, ledger, {
        ...sent(ledger),
        report: { grant: toWire(grant), pop: "00" },
      }),
    ).toBeDefined();
    expect(
      reportSenderProblem(appA, ledger, { ...sent(ledger), report: {} }),
    ).toBeDefined();
    // The same grant and proof, from a thread it is not held by.
    expect(
      reportSenderProblem(appA, ledger, {
        ...sent(ledger),
        from: { kind: "agent", key: "a/worker:runZ.0" },
      }),
    ).toBeDefined();
  });
});

describe("reports", () => {
  test("a report that breaks its schema is refused by the sender's check", () => {
    // `milestone = eventType("milestone", { schema: z.object({ pct: z.number().min(0).max(100), stage: z.literal("done") }) })`
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

  test("a report's data is the user's own: the routing sits under one reserved key", () => {
    const seen = resentAs({
      id: "r1",
      name: "agent/report",
      data: {
        to: "user-field",
        from: "user-field",
        grant: "user-field",
        "::agents": { agent: "a/boss", thread: "t", type: "approval" },
      },
      ts: 0,
      user: {},
    } as unknown as UntypedInboxMessage);

    expect(seen.name).toBe("approval");
    expect(seen.data).toEqual({
      to: "user-field",
      from: "user-field",
      grant: "user-field",
    });
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
          approved: true,
          "::agents": {
            agent: "a/boss",
            thread: boss,
            type: "approval",
            from: { kind: "agent", address: "a/security-reviewer", key },
          },
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
