/**
 * @module
 * Maps an SDK `AgentModelRequest` to the chat history `node-llama-cpp` takes.
 * Throwaway prototype.
 */
import type { AgentModelRequest } from "inngest/experimental/agents";

/**
 * The history items this prototype produces, a subset of node-llama-cpp's.
 */
export type HistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | {
      type: "model";
      response: Array<
        | string
        | {
            type: "functionCall";
            name: string;
            params: unknown;
            result: unknown;
          }
      >;
    };

type Block = { type: string; [key: string]: unknown };

const userText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return (content as Block[])
      .map((block) => {
        return block.type === "text" ? String(block.text) : JSON.stringify(block);
      })
      .join("\n");
  }

  return JSON.stringify(content);
};

/**
 * The request's system prompt and messages as chat history. An assistant
 * message and the tool results that answer it become one `model` item, which
 * is how node-llama-cpp records a function call and its result.
 */
export const toChatHistory = (request: AgentModelRequest): HistoryItem[] => {
  const history: HistoryItem[] = [];

  if (request.system) {
    history.push({ type: "system", text: request.system });
  }

  for (const message of request.messages) {
    if (message.role === "user") {
      history.push({ type: "user", text: userText(message.content) });

      continue;
    }

    if (message.role === "assistant") {
      const response: Extract<HistoryItem, { type: "model" }>["response"] = [];

      for (const block of (message.content ?? []) as Block[]) {
        if (block.type === "text" && typeof block.text === "string") {
          response.push(block.text);
        }

        if (block.type === "tool_use") {
          response.push({
            type: "functionCall",
            name: String(block.name),
            params: block.input,
            result: undefined,
          });
        }
      }

      history.push({ type: "model", response });

      continue;
    }

    const last = history.at(-1);

    if (last?.type !== "model") {
      continue;
    }

    for (const result of message.results) {
      const call = last.response.find((part) => {
        return (
          typeof part !== "string" &&
          part.name === result.name &&
          part.result === undefined
        );
      });

      if (call && typeof call !== "string") {
        call.result = result.content;
      }
    }
  }

  return history;
};
