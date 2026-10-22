/**
 * @module Shared pieces of the Agent SDK durability spike: a file backed
 * SessionStore (stands in for D1 or Postgres), in-process MCP tools over a
 * fake sandbox, an append-only evidence log, and a one-turn query runner.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** The key stays in the host environment; it is read once from the demo env file and never logged. */
if (!process.env.ANTHROPIC_API_KEY) {
  const line = readFileSync("/home/nixos/repo/demos/slack-box/.env", "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  process.env.ANTHROPIC_API_KEY = (line ?? "").slice("ANTHROPIC_API_KEY=".length).replace(/^['"]|['"]$/g, "").trim();
}

export const DATA = process.env.SPIKE_DATA ?? join(import.meta.dirname, "data");
mkdirSync(DATA, { recursive: true });

export function log(kind: string, data: Record<string, unknown> = {}): void {
  appendFileSync(
    join(DATA, "evidence.jsonl"),
    JSON.stringify({ t: Date.now(), pid: process.pid, kind, ...data }) + "\n",
  );
}

function keyFile(key: SessionKey): string {
  return join(DATA, "sessions", `${key.sessionId}${key.subpath ? "-" + key.subpath.replace(/\W/g, "_") : ""}.jsonl`);
}

export class FileSessionStore implements SessionStore {
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    mkdirSync(join(DATA, "sessions"), { recursive: true });
    log("store.append", { sessionId: key.sessionId, n: entries.length, types: entries.map((e) => e.type) });
    appendFileSync(keyFile(key), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const f = keyFile(key);
    if (!existsSync(f)) {
      log("store.load", { sessionId: key.sessionId, found: false });
      return null;
    }
    const entries = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    log("store.load", { sessionId: key.sessionId, found: true, n: entries.length });
    return entries;
  }
}

/**
 * Store that lives only in the process but is seeded from, and reports a delta
 * to, Inngest step outputs. The transcript then lives in run state: nothing to
 * provision, and a crashed turn cannot leave half written entries behind.
 */
export class StateSessionStore implements SessionStore {
  readonly delta: SessionStoreEntry[] = [];

  private readonly seed: SessionStoreEntry[];

  constructor(seed: SessionStoreEntry[]) {
    this.seed = seed;
  }

  async append(_key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.delta.push(...entries);
  }

  async load(_key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.seed.length ? [...this.seed, ...this.delta] : null;
  }
}

/** Fake sandbox: a JSON file of notes plus a call counter, to prove tool bodies run once. */
const sbFile = join(DATA, "sandbox.json");

export function sandboxState(): Record<string, string> {
  return existsSync(sbFile) ? JSON.parse(readFileSync(sbFile, "utf8")) : {};
}

export function resetSandbox(): void {
  writeFileSync(sbFile, "{}");
}

export function sandboxTools(opts: { slowMs?: number; wrap?: <T>(name: string, input: unknown, fn: () => Promise<T>) => Promise<T> } = {}) {
  const wrap = opts.wrap ?? (<T,>(_n: string, _i: unknown, fn: () => Promise<T>) => fn());
  return createSdkMcpServer({
    name: "box",
    version: "1.0.0",
    tools: [
      tool("write_note", "Write a note into the sandbox", { name: z.string(), text: z.string() }, async (args) => {
        return wrap("write_note", args, async () => {
        log("tool.start", { tool: "write_note", args });
        if (opts.slowMs) {
          await new Promise((r) => setTimeout(r, opts.slowMs));
        }
        const s = sandboxState();
        s[args.name] = args.text;
        writeFileSync(sbFile, JSON.stringify(s));
        log("tool.end", { tool: "write_note", args });
        return { content: [{ type: "text" as const, text: `wrote ${args.name}` }] };
        });
      }),
      tool("read_note", "Read a note from the sandbox", { name: z.string() }, async (args) => {
        return wrap("read_note", args, async () => {
        log("tool.start", { tool: "read_note", args });
        if (opts.slowMs) {
          await new Promise((r) => setTimeout(r, opts.slowMs));
        }
        const s = sandboxState();
        log("tool.end", { tool: "read_note", args });
        return { content: [{ type: "text" as const, text: s[args.name] ?? "(missing)" }] };
        });
      }),
    ],
  });
}

/** Only what the subprocess needs: the parent shell carries Claude Code session variables that would redirect auth. */
export function cleanEnv(configDir = join(DATA, "claude-config")): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    CLAUDE_CONFIG_DIR: configDir,
    ...(process.env.ANTHROPIC_BASE_URL_OVERRIDE ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL_OVERRIDE } : {}),
  };
}

export type TurnOutcome = {
  sessionId: string;
  done: boolean;
  text: string;
  stopReason: string | null;
  subtype: string;
  numTurns: number;
  costUsd: number;
  toolCalls: string[];
  assistantMessages: number;
  system: Record<string, unknown> | null;
  thrown?: string;
  structured?: unknown;
};

export type TurnOpts = {
  prompt: string;
  sessionId: string;
  resume: boolean;
  store: SessionStore;
  cwd: string;
  slowMs?: number;
  maxBudgetUsd?: number;
  canUseTool?: (name: string, input: Record<string, unknown>) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;
  extra?: Record<string, unknown>;
  systemPrompt?: string;
  configDir?: string;
  envExtra?: Record<string, string>;
  allowedTools?: string[];
  toolWrap?: <T>(name: string, input: unknown, fn: () => Promise<T>) => Promise<T>;
};

/** One query() with maxTurns 1: one assistant response plus its tool results. */
export async function runTurn(o: TurnOpts): Promise<TurnOutcome> {
  const out: TurnOutcome = {
    sessionId: o.sessionId, done: false, text: "", stopReason: null, subtype: "", numTurns: 0,
    costUsd: 0, toolCalls: [], assistantMessages: 0, system: null,
  };
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      model: "claude-haiku-4-5",
      tools: [],
      settingSources: ["project"],
      mcpServers: { box: sandboxTools({ slowMs: o.slowMs, wrap: o.toolWrap }) },
      allowedTools: o.allowedTools ?? ["mcp__box__*"],
      sessionStore: o.store,
      sessionStoreFlush: "eager",
      ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
      maxTurns: 1,
      ...(o.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: o.maxBudgetUsd }),
      canUseTool: o.canUseTool as never,
      env: { ...cleanEnv(o.configDir ?? mkdtempSync(join(tmpdir(), "claude-cfg-"))), ...(o.envExtra ?? {}) },
      ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
      ...(o.extra ?? {}),
    } as never,
  });
  try {
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "system" && m.subtype === "init") {
      out.system = { skills: m.skills, tools: m.tools, slash_commands: m.slash_commands, mcp_servers: m.mcp_servers };
    }
    if (m.type === "assistant") {
      out.assistantMessages++;
      for (const b of m.message.content) {
        if (b.type === "tool_use") out.toolCalls.push(b.name);
      }
    }
    if (m.type === "result") {
      out.subtype = m.subtype;
      out.numTurns = m.num_turns;
      out.costUsd = m.total_cost_usd;
      out.stopReason = m.stop_reason ?? null;
      out.text = m.result ?? "";
      out.structured = m.structured_output;
    }
  }
  } catch (err) {
    out.thrown = err instanceof Error ? err.message : String(err);
  }
  out.done = out.subtype === "success";
  log("turn.end", { sessionId: o.sessionId, ...out, system: undefined });
  return out;
}
