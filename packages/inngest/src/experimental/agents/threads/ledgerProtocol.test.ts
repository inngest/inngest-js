/**
 * @module
 * Tests for the parts of the ledger protocol that need no running ledger: the
 * signatures on its events, the `ttl` the ledger turns into an expiry, the
 * record a starter keeps of what its children owe, and the message a resend
 * keeps.
 */
import { _internals } from "../../../components/execution/engine.ts";
import { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { StepOpCode } from "../../../types.ts";
import { ledgerDataIsSigned, signLedgerData } from "../agent/relations.ts";
import { freshKv } from "../agent/test-helpers.ts";
import { flushOwes, noteOwes, owesRecord } from "../inbox/reports.ts";
import { inflightOf } from "../inbox/threadInbox.ts";
import {
  applyChange,
  createLedgerFunctions,
  emptyThreadState,
  type LedgerRunInput,
  type LedgerRunResult,
  liveKey,
  resolveTtl,
  type ThreadHandoverData,
} from "./ledger.ts";

describe("ledger signatures", () => {
  const writer = new Inngest({ id: "writer", signingKey: "signkey-test-aaaa" });
  const reader = new Inngest({ id: "reader", signingKey: "signkey-test-aaaa" });
  const other = new Inngest({ id: "other", signingKey: "signkey-test-bbbb" });
  const data = {
    thread: "t",
    app: "reader",
    runId: "r1",
    seq: 1,
    change: { op: "set", key: "k", value: { b: 1, a: [1, 2] } },
  };

  test("a signed event is accepted by another app of the environment", () => {
    const signed = signLedgerData(writer, "agent/thread.write", data);

    expect(signed.by).toBe("writer");
    expect(ledgerDataIsSigned(reader, "agent/thread.write", signed)).toBe(true);
  });

  test("key order does not matter, since the executor may reorder keys", () => {
    const signed = signLedgerData(writer, "agent/thread.write", data);
    const reordered = {
      sig: signed.sig,
      by: signed.by,
      change: { value: { a: [1, 2], b: 1 }, key: "k", op: "set" },
      seq: 1,
      runId: "r1",
      app: "reader",
      thread: "t",
    };

    expect(ledgerDataIsSigned(reader, "agent/thread.write", reordered)).toBe(
      true,
    );
  });

  test("unsigned, edited, moved and foreign-key events are refused", () => {
    const signed = signLedgerData(writer, "agent/thread.write", data);

    expect(ledgerDataIsSigned(reader, "agent/thread.write", data)).toBe(false);
    expect(
      ledgerDataIsSigned(reader, "agent/thread.write", { ...signed, seq: 2 }),
    ).toBe(false);
    expect(ledgerDataIsSigned(reader, "agent/thread.state", signed)).toBe(
      false,
    );
    expect(
      ledgerDataIsSigned(reader, "agent/thread.write", { ...signed, by: "x" }),
    ).toBe(false);
    expect(ledgerDataIsSigned(other, "agent/thread.write", signed)).toBe(false);
    expect(ledgerDataIsSigned(reader, "agent/thread.write", null)).toBe(false);
  });
});

describe("ledger expiry", () => {
  test("the ledger turns a ttl into an expiry from the event's time", () => {
    const change = resolveTtl({ op: "set", key: "k", value: 1, ttl: 10 }, 5000);
    const state = emptyThreadState();

    applyChange(state, change, [5000, "w", 1]);

    expect(change).toEqual({ op: "set", key: "k", value: 1, exp: 15000 });
    expect(liveKey(state, "k", 14999)?.v).toBe(1);
    expect(liveKey(state, "k", 15000)).toBeUndefined();
  });
});

describe("what a starter's children owe", () => {
  test("missing is what was owed less what came, once", async () => {
    const client = new Inngest({ id: testClientId });
    const thread = freshKv().with(client).scope("thread", "starter");
    const owes = owesRecord(thread, "app/starter");

    await owes.expect("child-1", ["milestone", "summary"]);
    await owes.expect("child-2", []);
    await owes.received("child-1", "milestone");
    await owes.received("child-1", "milestone");
    await owes.received("child-3", "milestone");

    expect(await owes.missing("child-1")).toEqual(["summary"]);
    expect(await owes.missing("child-1")).toBeUndefined();
    expect(await owes.missing("child-2")).toBeUndefined();
  });

  test("what a child owes noted inside a step is written once outside it", async () => {
    const client = new Inngest({ id: testClientId });
    const thread = freshKv().with(client).scope("thread", "starter");
    const owes = owesRecord(thread, "app/starter");
    const run = {};

    await noteOwes(run, true, owes, "child-1", ["summary"]);
    await noteOwes(run, true, owes, "child-2", []);
    expect(await owes.missing("child-1")).toBeUndefined();

    await noteOwes(run, true, owes, "child-1", ["summary"]);
    await flushOwes(run, owes);
    expect(await owes.missing("child-1")).toEqual(["summary"]);

    await noteOwes(run, false, owes, "child-3", ["x"]);
    expect(await owes.missing("child-3")).toEqual(["x"]);
  });
});

describe("a failed turn's resend", () => {
  test("keeps the message's id and sender", () => {
    expect(
      inflightOf({
        id: "evt-1",
        name: "agent/message",
        data: { content: "hi", from: { kind: "agent", key: "p" } },
      }),
    ).toEqual({
      content: "hi",
      id: "evt-1",
      from: { kind: "agent", key: "p" },
    });
  });
});

describe("ledger durability", () => {
  test("a ledger request that fails is tried again, so an app restart does not lose the thread's state", () => {
    const client = new Inngest({ id: "durable-app", isDev: true });
    const fns = createLedgerFunctions(client);

    expect(fns).toHaveLength(2);

    for (const fn of fns) {
      expect(
        (fn as unknown as { opts: { retries?: number } }).opts.retries,
      ).toBeGreaterThan(0);
    }
  });
});

describe("ledger handover", () => {
  const client = new Inngest({ id: "handover-app", isDev: true });
  const supervisor = createLedgerFunctions(client).find((fn) => {
    return fn.id("handover-app").endsWith("agents-thread-ledger");
  }) as InngestFunction.Any;
  const thread = "inngest:kv:thread:default:handover-app:t";
  const write = {
    id: "evt-1",
    name: "agent/thread.write",
    ts: 1,
    data: signLedgerData(client, "agent/thread.write", {
      thread,
      app: "handover-app",
      runId: "r1",
      seq: 1,
      change: { op: "set", key: "k", value: 1 },
    }),
  };
  const step = (id: string, data: unknown) => {
    const hashed = _internals.hashId(id);

    return { [hashed]: { id: hashed, data } };
  };
  const next = async (memos: Record<string, unknown>) => {
    const state = Object.assign(
      {},
      ...Object.entries(memos).map(([id, data]) => step(id, data)),
    );

    return runFnWithStack(supervisor, state, { event: write, events: [write] });
  };
  const invoked = (
    result: Awaited<ReturnType<typeof next>>,
  ): { id: string; input: LedgerRunInput } => {
    if (result.type !== "steps-found") {
      throw new Error(`expected a step, got ${result.type}`);
    }

    const op = result.steps[0];

    expect(op?.op).toBe(StepOpCode.InvokeFunction);

    return {
      id: String(op?.userland?.id ?? op?.id),
      input: (op?.opts as { payload: { data: LedgerRunInput } }).payload.data,
    };
  };

  test("the first message starts the first run, which is not a handover", async () => {
    const { id, input } = invoked(await next({}));

    expect(id).toBe("run:1");
    expect(input.carried).toBeUndefined();
    expect(input.start?.name).toBe("agent/thread.write");
    expect(input.start?.data).toEqual(write.data);
  });

  test("the state a run hands over goes to the next run, and the supervisor does not end between them", async () => {
    const carried: ThreadHandoverData = signLedgerData(
      client,
      "agent/thread.handover",
      {
        thread,
        app: "handover-app",
        version: 7,
        state: { keys: { k: { v: 1, at: [1, "r1", 1] } }, indexes: {} },
        last: { r1: 1 },
      },
    ) as ThreadHandoverData;
    const handed: LedgerRunResult = { thread, version: 7, handover: carried };

    const { id, input } = invoked(await next({ "run:1": handed }));

    expect(id).toBe("run:2");
    expect(input.carried).toEqual(carried);
    expect(input.start).toBeUndefined();
  });

  test("the supervisor ends when a run ends without handing over", async () => {
    const ended: LedgerRunResult = { thread, version: 7 };
    const result = await next({ "run:1": ended });

    expect(result.type).toBe("function-resolved");
  });
});
