/**
 * @module
 * `localModel(name)`: an SDK model function that runs a small GGUF in this
 * process with `node-llama-cpp`. Throwaway prototype.
 */
import {
  defineChatSessionFunction,
  getLlama,
  LlamaChat,
  type Llama,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaModel,
} from "node-llama-cpp";
import type {
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
} from "inngest/experimental/agents";

import { toChatHistory } from "./history.ts";

/**
 * How the tour would sample. Low temperature keeps tool arguments stable.
 */
export const sampling = {
  temperature: 0.2,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  maxTokens: 512,
} as const;

/**
 * What the last model call cost, read by the harness after each call.
 */
export interface CallStats {
  /**
   * Prompt tokens evaluated, after prefix reuse.
   */
  promptTokens: number;
  outputTokens: number;
  firstTokenMs: number;
  totalMs: number;
  raw: string;
  stopReason: string;
}

export interface LocalModel {
  model: AgentModel;
  last: () => CallStats;
  loadMs: number;
  dispose: () => Promise<void>;
}

export interface LocalModelOptions {
  /**
   * Reuse the evaluated prompt prefix between calls (the shipping setting).
   */
  cache?: boolean;
  threads?: number;
  contextSize?: number;
}

const noop = () => {
  return undefined;
};

/**
 * Loads the GGUF at `file` and returns the model function for it.
 */
export const localModel = async (
  file: string,
  options: LocalModelOptions = {},
): Promise<LocalModel> => {
  const { cache = true, threads, contextSize = 8192 } = options;
  const started = performance.now();
  const llama: Llama = await getLlama();
  const loaded: LlamaModel = await llama.loadModel({ modelPath: file });
  const context: LlamaContext = await loaded.createContext({
    contextSize,
    ...(threads ? { threads } : {}),
  });
  const sequence: LlamaContextSequence = context.getSequence();
  const chat = new LlamaChat({ contextSequence: sequence });
  const loadMs = performance.now() - started;
  let last: CallStats = {
    promptTokens: 0,
    outputTokens: 0,
    firstTokenMs: 0,
    totalMs: 0,
    raw: "",
    stopReason: "",
  };

  const model = async (
    request: AgentModelRequest,
  ): Promise<AgentModelResponse> => {
    if (!cache) {
      await sequence.clearHistory();
    }

    const functions: Record<string, ReturnType<typeof defineChatSessionFunction>> =
      {};

    if (request.toolChoice !== "none") {
      for (const tool of request.tools) {
        functions[tool.name] = defineChatSessionFunction({
          description: tool.description ?? "",
          // The library takes a subset of JSON Schema.
          params: tool.input_schema as never,
          handler: noop,
        });
      }
    }

    const begun = performance.now();
    let firstTokenMs = 0;
    let outputTokens = 0;
    const result = await chat.generateResponse(
      toChatHistory(request) as never,
      {
        ...sampling,
        functions: Object.keys(functions).length > 0 ? functions : undefined,
        budgets: { thoughtTokens: 0 },
        onToken: (tokens) => {
          if (outputTokens === 0) {
            firstTokenMs = performance.now() - begun;
          }

          outputTokens += tokens.length;
        },
      },
    );
    const totalMs = performance.now() - begun;
    const toolCalls = (result.functionCalls ?? []).map((call, index) => {
      return {
        id: `call-${request.turn}-${index}`,
        name: call.functionName,
        input: call.params,
      };
    });
    const text = result.response.trim();

    last = {
      promptTokens: result.metadata ? sequence.nextTokenIndex : 0,
      outputTokens,
      firstTokenMs,
      totalMs,
      raw: result.response,
      stopReason: String(result.metadata?.stopReason ?? ""),
    };

    return {
      message: {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...toolCalls.map((call) => {
            return { type: "tool_use", ...call };
          }),
        ],
      },
      text,
      toolCalls,
      usage: { input: 0, output: outputTokens },
      model: file,
    };
  };

  return {
    model,
    last: () => {
      return last;
    },
    loadMs,
    dispose: async () => {
      await context.dispose();
      await loaded.dispose();
      await llama.dispose();
    },
  };
};
