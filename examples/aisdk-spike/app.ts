import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount, streamText, tool } from "ai";
import { Inngest } from "inngest";
import { durable, sandboxMiddleware } from "inngest/experimental";
import { serve } from "inngest/node";
import { z } from "zod/v4";

const readKey = (): string => {
  const text = fs.readFileSync("/home/nixos/repo/demos/slack-box/.env", "utf8");
  const line = text.split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  return (line ?? "").slice("ANTHROPIC_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
};

const apiKey = readKey();
const logPath = process.env.SPIKE_LOG ?? "/tmp/aisdk-spike.jsonl";
const modelId = process.env.SPIKE_MODEL ?? "claude-haiku-4-5";

const log = (entry: Record<string, unknown>): void => {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};

const counterPath = (key: string): string => `${logPath}.${key}`;
const bump = (key: string): number => {
  let n = 0;
  try {
    n = Number(fs.readFileSync(counterPath(key), "utf8"));
  } catch {}
  fs.writeFileSync(counterPath(key), String(n + 1));
  return n + 1;
};

const inngest = new Inngest({ id: "aisdk-spike", middleware: [sandboxMiddleware()] });

const canon = (v: any): any => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const sha = (value: unknown): string => {
  return crypto.createHash("sha1").update(JSON.stringify(canon(value)) ?? "").digest("hex").slice(0, 8);
};

/** Logs every step id and a hash of its output, per invocation. */
const spy = (step: any, runId: string, inv: number) => {
  return new Proxy(step, {
    get: (target, prop, receiver) => {
      if (prop === "run") {
        return async (id: unknown, fn: any, ...rest: any[]) => {
          const name = typeof id === "string" ? id : (id as any).id;
          const out = await target.run(id, fn, ...rest);
          log({ t: "step", kind: "run", runId, inv, id: name, hash: sha(out), bytes: JSON.stringify(out ?? null).length });
          return out;
        };
      }
      if (prop === "ai") {
        return {
          ...target.ai,
          wrap: async (id: string, fn: any, ...rest: any[]) => {
            const out = await target.ai.wrap(id, fn, ...rest);
            log({ t: "step", kind: "ai.wrap", runId, inv, id, hash: sha(out), bytes: JSON.stringify(out ?? null).length });
            return out;
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
};

const weather = (runId: string) =>
  tool({
    description: "Get the current weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }, { toolCallId }) => {
      const start = Date.now();
      log({ t: "tool-start", runId, name: "weather", toolCallId, city });
      await new Promise((r) => setTimeout(r, 300));
      log({ t: "tool-end", runId, name: "weather", toolCallId, ms: Date.now() - start });
      return { city, tempC: 10 + city.length, sky: "clear" };
    },
  });

const clock = (runId: string) =>
  tool({
    description: "Get the current time in a timezone",
    inputSchema: z.object({ tz: z.string() }),
    execute: async ({ tz }, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "clock", toolCallId });
      return { tz, time: "12:00" };
    },
  });

const calc = (runId: string) =>
  tool({
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "calc", toolCallId });
      return { sum: a + b };
    },
  });

/** A counter whose value is held by the caller: each call must be a separate model turn. */
const counter = (runId: string) =>
  tool({
    description: "Increment the shared counter by one and return its new value",
    inputSchema: z.object({}),
    execute: async (_input, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "counter", toolCallId });
      return { note: "incremented" };
    },
  });

const slow = (runId: string, ms: number) =>
  tool({
    description: "Run a slow job",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "slow", toolCallId });
      await new Promise((r) => setTimeout(r, ms));
      log({ t: "tool-end", runId, name: "slow", toolCallId });
      return { name, done: true };
    },
  });

const big = (runId: string) =>
  tool({
    description: "Fetch a big document",
    inputSchema: z.object({ kb: z.number() }),
    execute: async ({ kb }, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "big", toolCallId });
      return { text: "x".repeat(kb * 1024).slice(0, kb * 1024), kb };
    },
  });

const danger = (runId: string) =>
  tool({
    description: "Delete a customer record. Requires approval.",
    inputSchema: z.object({ customer: z.string() }),
    needsApproval: true,
    execute: async ({ customer }, { toolCallId }) => {
      log({ t: "tool-start", runId, name: "danger", toolCallId, customer });
      return { deleted: customer };
    },
  });

/** Wraps fetch to count real HTTP calls and inject failures from the event. */
const makeFetch = (runId: string, inject?: { status: number; times: number; retryAfter?: number }) => {
  return async (input: any, init: any) => {
    const n = bump(`http-${runId}`);
    log({ t: "http", runId, n });
    if (inject) {
      const failed = bump(`fail-${runId}`);
      if (failed <= inject.times) {
        log({ t: "injected", runId, status: inject.status, failed });
        return new Response(
          JSON.stringify({ type: "error", error: { type: inject.status === 429 ? "rate_limit_error" : "invalid_request_error", message: `injected ${inject.status}` } }),
          {
            status: inject.status,
            headers: { "content-type": "application/json", ...(inject.retryAfter !== undefined && { "retry-after": String(inject.retryAfter) }) },
          },
        );
      }
    }
    return fetch(input, init);
  };
};

const toolsFor = (runId: string, names: string[], slowMs = 20000) => {
  const all: Record<string, any> = {
    weather: weather(runId),
    clock: clock(runId),
    calc: calc(runId),
    counter: counter(runId),
    slow: slow(runId, slowMs),
    big: big(runId),
    danger: danger(runId),
  };
  return Object.fromEntries(names.map((n) => [n, all[n]]));
};

const body = async ({ event, step: rawStep, runId }: any) => {
  const data = event.data as {
    scenario?: string;
    prompt: string;
    tools?: string[];
    thinking?: boolean;
    aiWrap?: boolean;
    maxSteps?: number;
    inject?: { status: number; times: number; retryAfter?: number };
    slowMs?: number;
    catchError?: boolean;
    prepare?: boolean;
    stripMeta?: boolean;
    abortMs?: number;
    noFill?: boolean;
  };
  const inv = bump(`inv-${runId}`);
  log({ t: "invoke", runId, inv, scenario: data.scenario });
  const step = spy(rawStep, runId, inv);
  const base = createAnthropic({ apiKey, fetch: makeFetch(runId, data.inject) as any });
  const provider = (id: string) => {
    const real: any = base(id);
    if (!data.stripMeta) return real;
    return {
      specificationVersion: real.specificationVersion,
      provider: real.provider,
      modelId: real.modelId,
      get supportedUrls() { return real.supportedUrls; },
      doStream: (p: any) => real.doStream(p),
      doGenerate: async (p: any) => {
        const r = await real.doGenerate(p);
        return { ...r, response: { headers: r.response?.headers } };
      },
    } as any;
  };
  const d = durable(step, { aiWrap: data.aiWrap, fillMetadata: !data.noFill });
  const providerOptions = data.thinking
    ? { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } }
    : undefined;
  const toolNames = data.tools ?? ["weather", "clock", "calc"];
  const maxSteps = data.maxSteps ?? 10;

  const callbacks = {
    onStepFinish: (s: any) => {
      log({ t: "onStepFinish", runId, inv, finish: s.finishReason, respId: s.response?.id, respTs: String(s.response?.timestamp) });
    },
    onToolExecutionStart: (e: any) => {
      log({ t: "onToolExecutionStart", runId, inv, tool: e.toolCall?.toolName });
    },
  };

  if (data.scenario === "stream") {
    const result = streamText({
      model: d.model(provider(modelId)),
      tools: d.tools(toolsFor(runId, toolNames)),
      stopWhen: isStepCount(maxSteps),
      maxRetries: 0,
      prompt: data.prompt,
      ...callbacks,
    });
    const chunks: { at: number; text: string }[] = [];
    const start = Date.now();
    for await (const chunk of result.textStream) {
      chunks.push({ at: Date.now() - start, text: chunk });
    }
    log({ t: "stream-chunks", runId, inv, count: chunks.length, first: chunks[0]?.at, last: chunks.at(-1)?.at });
    return { text: await result.text, chunks: chunks.length };
  }

  if (data.scenario === "approval") {
    const tools = d.tools(toolsFor(runId, ["danger"]));
    const first = await generateText({
      model: d.model(provider(modelId)),
      tools,
      stopWhen: isStepCount(maxSteps),
      maxRetries: 0,
      prompt: data.prompt,
      ...callbacks,
    });
    const requests = first.content.filter((p: any) => p.type === "tool-approval-request") as any[];
    log({ t: "approval-requests", runId, inv, count: requests.length, ids: requests.map((r) => r.approvalId) });
    if (requests.length === 0) {
      return { text: first.text, note: "no approval needed" };
    }
    const reply = await step.waitForEvent("wait-approval", { event: "spike/approval", timeout: "2m", if: `async.data.runId == "${runId}"` });
    const approved = reply?.data?.approved === true;
    log({ t: "approval-reply", runId, inv, approved });
    const second = await generateText({
      model: d.model(provider(modelId)),
      tools,
      stopWhen: isStepCount(maxSteps),
      maxRetries: 0,
      messages: [
        { role: "user", content: data.prompt },
        ...first.response.messages,
        {
          role: "tool",
          content: requests.map((r) => ({ type: "tool-approval-response", approvalId: r.approvalId, approved, reason: approved ? undefined : "denied" })),
        },
      ] as any,
    });
    return { text: second.text, approved };
  }

  if (data.scenario === "subagents") {
    const run = (id: string, prompt: string) => {
      const sub = durable(step, { id });
      return generateText({
        model: sub.model(provider(modelId)),
        tools: sub.tools(toolsFor(runId, ["weather"])),
        stopWhen: isStepCount(maxSteps),
        maxRetries: 0,
        prompt,
      });
    };
    const [a, b] = await Promise.all([run("agent-a", "Weather in Oslo? One sentence."), run("agent-b", "Weather in Cairo? One sentence.")]);
    return { a: a.text, b: b.text };
  }

  if (data.scenario === "sbraw") {
    await using sandbox = (step as any).sandbox.lazy("box", { name: "box", vcpu: 1, memoryMb: 1024 });
    const out: any = {};
    for (const [k, cmd, opts] of [["plain", ["echo", "hi"], {}], ["cwd", ["echo", "hi"], { cwd: "/work" }], ["env", ["/bin/sh", "-c", "echo $P"], { environment: { P: "x" } }], ["timeout", ["echo", "hi"], { timeout: "5m" }]] as any) {
      try { out[k] = (await sandbox.commands.run(k, cmd, opts)).stdout; } catch (e: any) { out[k] = { err: e.message, details: JSON.stringify(e.cause?.details ?? e.cause) }; }
    }
    return out;
  }

  if (data.scenario === "sandbox") {
    await using sandbox = (step as any).sandbox.lazy("box", { name: "box", vcpu: 1, memoryMb: 1024 });
    const result = await generateText({
      model: d.model(provider(modelId)),
      tools: d.tools(sandbox.tools.code({ cwd: "/tmp", only: ["run", "write", "read"] })),
      stopWhen: isStepCount(maxSteps),
      maxRetries: 0,
      prompt: data.prompt,
      ...callbacks,
    });
    return { text: result.text, steps: result.steps.length, tools: result.steps.flatMap((s: any) => s.toolCalls.map((c: any) => c.toolName)) };
  }

  if (data.scenario === "plain") {
    // Baseline: no durable wrapper at all, the whole loop in one step for comparison.
    const out = await step.run("loop", async () => {
      const r = await generateText({
        model: provider(modelId),
        tools: toolsFor(runId, toolNames),
        stopWhen: isStepCount(maxSteps),
        prompt: data.prompt,
      });
      return { text: r.text, steps: r.steps.length };
    });
    return out;
  }

  try {
    const result = await generateText({
      model: d.model(provider(modelId)),
      tools: d.tools(toolsFor(runId, toolNames, data.slowMs ?? 20000)),
      stopWhen: isStepCount(maxSteps),
      maxRetries: 0,
      prompt: data.prompt,
      providerOptions: providerOptions as any,
      ...(data.abortMs && { abortSignal: AbortSignal.timeout(data.abortMs) }),
      ...(data.prepare && {
        prepareStep: d.prepareStep({
          steer: async (turn) => {
            const note = await step.run(`steer:${turn}`, async () => (turn === 1 ? "Also mention the word PINEAPPLE." : undefined));
            return note ? [note] : undefined;
          },
          maxSteps,
          wrapUp: "Wrap up now.",
          clip: { maxChars: 200_000 },
        }),
      }),
      ...callbacks,
    });
    const reasoning = result.steps.flatMap((s: any) => s.content.filter((p: any) => p.type === "reasoning")).length;
    log({ t: "done", runId, inv, steps: result.steps.length, reasoning, usage: result.usage });
    return {
      text: result.text,
      steps: result.steps.length,
      reasoning,
      toolCalls: result.steps.flatMap((s: any) => s.toolCalls.map((c: any) => c.toolName)),
      responseIds: result.steps.map((s: any) => s.response.id),
      timestamps: result.steps.map((s: any) => String(s.response.timestamp)),
    };
  } catch (error: any) {
    log({ t: "user-saw-error", runId, inv, name: error?.name, ctor: error?.constructor?.name, isAPICallError: error?.name === "AI_APICallError", message: String(error?.message).slice(0, 200), cause: error?.cause?.name });
    if (data.catchError) {
      return { caught: { name: error?.name, message: String(error?.message).slice(0, 200), cause: error?.cause?.name } };
    }
    throw error;
  }
};

const fns = [
  inngest.createFunction({ id: "agent", triggers: [{ event: "spike/run" }] }, body),
  inngest.createFunction({ id: "agent-nocp", checkpointing: false, triggers: [{ event: "spike/run-nocp" }] }, body),
];

http
  .createServer(serve({ client: inngest, functions: fns, servePath: "/api/inngest" }))
  .listen(Number(process.env.PORT));
