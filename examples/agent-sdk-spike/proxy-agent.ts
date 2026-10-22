/**
 * @module Proxy variant of the Agent SDK spike. ANTHROPIC_BASE_URL points at an
 * in-process HTTP endpoint; every model request becomes step.run("model:" + hash)
 * and its full SSE body is memoized. Tool bodies become tool steps. The whole
 * agent loop is ONE query() per invocation, replayed from the top on re-entry.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Inngest } from "inngest";
import { DATA, log, resetSandbox, runTurn, sandboxState, StateSessionStore } from "./lib.ts";

type StepTools = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };
type RunCtx = { abort: AbortController; step: StepTools; toolSeq: Map<string, number>; injectFailOnce?: boolean; requests: number };

const runs = new Map<string, RunCtx>();
let port = 0;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Strip the fields that legitimately vary between replays of the same turn. */
export function normalize(body: Record<string, any>, mode: "raw" | "normalized"): string {
  const text = JSON.stringify(body);
  if (mode === "raw") {
    return text;
  }
  return text
    .replace(/cc_version=[^;]*;/g, "cc_version=X;")
    .replace(/\\"device_id\\":\\"[0-9a-f]+\\"/g, '\\"device_id\\":\\"X\\"')
    .replace(/Today's date is \d{4}-\d{2}-\d{2}\./g, "Today's date is D.");
}

const proxy = createServer(async (req, res) => {
  const m = /^\/r\/([^/]+)(\/.*)$/.exec(req.url ?? "");
  const ctx = m ? runs.get(m[1]) : undefined;
  if (!m || !ctx) {
    res.writeHead(404);
    res.end("no run");
    return;
  }
  const upstreamPath = m[2];
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks);
  const body = JSON.parse(raw.toString());
  const hash = sha(normalize(body, (process.env.HASH_MODE as "raw") ?? "normalized"));
  ctx.requests++;
  if (process.env.DUMP_REQ) {
    mkdirSync(join(DATA, "req"), { recursive: true });
    writeFileSync(join(DATA, "req", `${Date.now()}-${hash}.json`), JSON.stringify(JSON.parse(normalize(body, "normalized")), null, 1));
  }
  const id = `model:${hash}`;
  log("proxy.req", { id, msgs: body.messages?.length, tools: body.tools?.length, stream: body.stream });
  try {
    const out = await ctx.step.run(id, async () => {
      log("proxy.upstream", { id });
      if (ctx.injectFailOnce) {
        ctx.injectFailOnce = false;
        throw new Error("injected upstream failure");
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) {
          headers[k] = v;
        }
      }
      headers["x-api-key"] = process.env.ANTHROPIC_API_KEY ?? "";
      delete headers.authorization;
      const up = await fetch(`https://api.anthropic.com${upstreamPath}`, { method: "POST", headers, body: raw });
      const text = await up.text();
      if (up.status === 429 || up.status >= 500) {
        throw new Error(`upstream ${up.status}`);
      }
      const rh: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) {
          rh[k] = v;
        }
      });
      return { status: up.status, headers: rh, text };
    });
    res.writeHead(out.status, out.headers);
    res.end(out.text);
  } catch (err) {
    log("proxy.err", { id, err: String(err) });
    res.writeHead(529, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: String(err) } }));
  }
});

const ready = new Promise<void>((resolve) => {
  proxy.listen(0, "127.0.0.1", () => {
    port = (proxy.address() as { port: number }).port;
    resolve();
  });
});

const CHECKOUT = join(import.meta.dirname, "host/website");

export function registerProxyFunctions(inngest: Inngest) {
  const proxyAgent = inngest.createFunction(
    { id: "proxy-agent", retries: 10, triggers: [{ event: "spike/proxy" }] },
    async ({ event, step, runId }) => {
      await ready;
      const d = event.data as { prompt: string; nested?: boolean; slowMs?: number; reset?: boolean; failOnce?: boolean; maxTurns?: number; tools?: boolean };
      log("fn.invoke", { fn: "proxy-agent", runId, nested: !!d.nested });
      await step.run("reset", () => {
        if (d.reset) {
          resetSandbox();
        }
        return true;
      });
      runs.get(runId)?.abort.abort();
      const ctx: RunCtx = { abort: new AbortController(), step: step as unknown as StepTools, toolSeq: new Map(), injectFailOnce: d.failOnce, requests: 0 };
      runs.set(runId, ctx);
      const sessionId = [sha(runId + "a"), sha(runId + "b"), sha(runId + "c")].join("").slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      const toolWrap = async <T,>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> => {
        const key = `${name}:${sha(JSON.stringify(input))}`;
        const n = (ctx.toolSeq.get(key) ?? 0) + 1;
        ctx.toolSeq.set(key, n);
        return ctx.step.run(`tool:${key}${n > 1 ? `:${n}` : ""}`, fn);
      };
      const body = () =>
        runTurn({
          prompt: d.prompt,
          sessionId,
          resume: false,
          store: new StateSessionStore([]),
          cwd: CHECKOUT,
          slowMs: d.slowMs,
          toolWrap,
          envExtra: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/r/${runId}` },
          extra: { maxTurns: d.maxTurns ?? 10, sessionStore: undefined, abortController: ctx.abort },
        });
      const outcome = d.nested ? await step.run("whole-agent", body) : await body();
      runs.delete(runId);
      ctx.abort.abort();
      return { outcome: { ...outcome, system: undefined }, requests: ctx.requests, notes: sandboxState() };
    },
  );
  return [proxyAgent];
}
