/**
 * @module Inngest app for the Agent SDK durability spike. Function `a1b` is the
 * per-turn wrapper (one query() per step, sessionStore plus resume). The proxy
 * variant lives in proxy-agent.ts.
 */
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { DATA, FileSessionStore, StateSessionStore, log, resetSandbox, runTurn, type TurnOutcome } from "./lib.ts";
import { registerProxyFunctions } from "./proxy-agent.ts";

export const inngest = new Inngest({ id: process.env.APP_ID ?? "agent-sdk-spike" });

const CHECKOUT = join(import.meta.dirname, "host/website");

const a1b = inngest.createFunction(
  { id: "a1b", retries: 10, triggers: [{ event: "spike/a1b" }] },
  async ({ event, step, runId }) => {
    const d = event.data as {
      prompt: string;
      store?: "file" | "state";
      maxTurns?: number;
      slowMs?: number;
      budget?: number;
      approve?: boolean;
      key?: string;
      reset?: boolean;
    };
    log("fn.invoke", { fn: "a1b", runId });
    const mode = d.store ?? "file";
    const sessionId = await step.run("session", () => {
      if (d.reset) {
        resetSandbox();
      }
      return crypto.randomUUID();
    });
    const fileStore = new FileSessionStore();
    const transcript: SessionStoreEntry[] = [];
    const approved = new Set<string>();
    let spent = 0;
    const turns: Array<Pick<TurnOutcome, "subtype" | "toolCalls" | "costUsd" | "stopReason" | "text">> = [];
    let prompt = d.prompt;

    for (let turn = 1; turn <= (d.maxTurns ?? 8); turn++) {
      let pending: { tool: string; input: Record<string, unknown> } | null = null;
      const res = await step.run(`turn-${turn}`, async () => {
        log("turn.start", { runId, turn, mode });
        const store = mode === "state" ? new StateSessionStore(transcript) : fileStore;
        const outcome = await runTurn({
          prompt,
          sessionId,
          resume: turn > 1,
          store,
          cwd: CHECKOUT,
          slowMs: d.slowMs,
          maxBudgetUsd: d.budget === undefined ? undefined : Math.max(d.budget - spent, 0.000001),
          allowedTools: d.approve ? ["mcp__box__read_note"] : undefined,
          canUseTool: !d.approve ? undefined : async (name, input) => {
            log("canUseTool", { name, input });
            if (d.approve && !approved.has(JSON.stringify(input))) {
              pending = { tool: name, input };
              return { behavior: "deny", message: "A human must approve this call first. Stop and wait.", interrupt: true } as never;
            }
            return { behavior: "allow" };
          },
        });
        return {
          outcome,
          pending,
          delta: mode === "state" ? (store as StateSessionStore).delta : [],
        };
      });
      transcript.push(...res.delta);
      spent += res.outcome.costUsd;
      turns.push({
        subtype: res.outcome.subtype,
        toolCalls: res.outcome.toolCalls,
        costUsd: res.outcome.costUsd,
        stopReason: res.outcome.stopReason,
        text: res.outcome.text,
      });

      if (res.pending) {
        const answer = await step.waitForEvent(`approval-${turn}`, {
          event: "spike/approve",
          timeout: "2m",
          if: `async.data.key == "${d.key ?? "k"}"`,
        });
        if (!answer || answer.data.ok === false) {
          return { turns, spent, denied: true };
        }
        approved.add(JSON.stringify(res.pending.input));
        prompt = `The human approved the ${res.pending.tool} call with ${JSON.stringify(res.pending.input)}. Make that call now.`;
        continue;
      }
      if (res.outcome.done || res.outcome.subtype === "error_max_budget_usd") {
        break;
      }
      prompt = "continue";
    }
    return { turns, spent, notes: Object.keys((await import("./lib.ts")).sandboxState()) };
  },
);

/** Walk a directory into a path to content map (the fake website is tiny). */
function readTree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      readTree(p, base, out);
    } else {
      out[relative(base, p)] = readFileSync(p, "utf8");
    }
  }
  return out;
}

/**
 * Variant a1c: Claude Code's own Read/Edit/Write/Glob/Grep stay on, running
 * against a host checkout. Each turn's file changes are returned as step output
 * and re-applied to a fresh checkout, so the work survives a host change.
 */
const a1c = inngest.createFunction(
  { id: "a1c", retries: 10, triggers: [{ event: "spike/a1c" }] },
  async ({ event, step }) => {
    const d = event.data as { prompt: string; maxTurns?: number };
    const sessionId = await step.run("session", () => crypto.randomUUID());
    const transcript: SessionStoreEntry[] = [];
    let files: Record<string, string> = {};
    let structured: unknown = null;
    const turns: Array<{ subtype: string; toolCalls: string[]; text: string }> = [];
    let prompt = d.prompt;
    for (let turn = 1; turn <= (d.maxTurns ?? 8); turn++) {
      const res = await step.run(`turn-${turn}`, async () => {
        log("turn.start", { fn: "a1c", turn });
        const work = join(tmpdir(), `website-${sessionId}`);
        rmSync(work, { recursive: true, force: true });
        cpSync(CHECKOUT, work, { recursive: true });
        for (const [path, content] of Object.entries(files)) {
          writeFileSync(join(work, path), content);
        }
        const before = readTree(work);
        const store = new StateSessionStore(transcript);
        const outcome = await runTurn({
          prompt,
          sessionId,
          resume: turn > 1,
          store,
          cwd: work,
          allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Skill"],
          extra: {
            tools: ["Read", "Edit", "Write", "Glob", "Grep", "Skill"],
            disallowedTools: ["Bash", "WebFetch", "WebSearch", "Agent", "NotebookEdit"],
            permissionMode: "dontAsk",
            outputFormat: { type: "json_schema", schema: { type: "object", properties: { summary: { type: "string" }, pages: { type: "array", items: { type: "string" } } }, required: ["summary", "pages"], additionalProperties: false } },
          },
        });
        const after = readTree(work);
        const changed: Record<string, string> = {};
        for (const [path, content] of Object.entries(after)) {
          if (before[path] !== content) {
            changed[path] = content;
          }
        }
        log("turn.files", { turn, changed: Object.keys(changed) });
        return { outcome, delta: store.delta, changed };
      });
      transcript.push(...res.delta);
      files = { ...files, ...res.changed };
      structured = res.outcome.structured ?? structured;
      turns.push({ subtype: res.outcome.subtype, toolCalls: res.outcome.toolCalls, text: res.outcome.text });
      if (res.outcome.done) {
        break;
      }
      prompt = "continue";
    }
    const final = { turns, files: Object.keys(files), page: files["docs/page.md"], structured };
    log("a1c.result", final);
    return final;
  },
);

const fns = [a1b, a1c, ...registerProxyFunctions(inngest)];

if (process.env.CONNECT) {
  const { connect } = await import("inngest/connect");
  await connect({ apps: [{ client: inngest, functions: fns }], instanceId: "agsdk-connect" });
} else {
  createServer(serve({ client: inngest, functions: fns, servePath: "/api/inngest" })).listen(Number(process.env.PORT));
}
log("app.boot", { port: process.env.PORT, data: DATA });
