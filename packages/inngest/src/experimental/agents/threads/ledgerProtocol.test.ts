/**
 * @module
 * Tests for the parts of the ledger protocol that need no running ledger: the
 * signatures on its events, the `ttl` the ledger turns into an expiry, the
 * record a starter keeps of what its children owe, and the message a resend
 * keeps.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { ledgerDataIsSigned, signLedgerData } from "../agent/relations.ts";
import { freshKv } from "../agent/test-helpers.ts";
import { owesRecord } from "../inbox/reports.ts";
import { inflightOf } from "../inbox/threadInbox.ts";
import {
  applyChange,
  emptyThreadState,
  liveKey,
  resolveTtl,
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

    applyChange(state, change, 5000);

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
