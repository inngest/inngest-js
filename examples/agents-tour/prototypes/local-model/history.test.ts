/**
 * @module
 * The seam of the adapter: an `AgentModelRequest` in, the chat history the
 * model sees out. Throwaway prototype.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toChatHistory } from "./history.ts";

test("a system prompt and a user message become two history items", () => {
  const history = toChatHistory({
    system: "You help.",
    messages: [{ role: "user", content: "hi" }],
    turn: 1,
    maxTurns: 10,
    tools: [],
  });

  assert.deepEqual(history, [
    { type: "system", text: "You help." },
    { type: "user", text: "hi" },
  ]);
});

test("a tool call and its result fold into one model item", () => {
  const history = toChatHistory({
    messages: [
      { role: "user", content: "where is A-1?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "lookup_order",
            input: { order_id: "A-1" },
          },
        ],
      },
      {
        role: "tool",
        results: [
          {
            toolCallId: "c1",
            name: "lookup_order",
            input: { order_id: "A-1" },
            content: '{"status":"shipped"}',
          },
        ],
      },
    ],
    turn: 2,
    maxTurns: 10,
    tools: [],
  });

  assert.equal(history.length, 2);
  assert.deepEqual(history[1], {
    type: "model",
    response: [
      {
        type: "functionCall",
        name: "lookup_order",
        params: { order_id: "A-1" },
        result: '{"status":"shipped"}',
      },
    ],
  });
});

test("an assistant text after a tool result starts a new model item", () => {
  const history = toChatHistory({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "next" },
    ],
    turn: 2,
    maxTurns: 10,
    tools: [],
  });

  assert.deepEqual(
    history.map((item) => {
      return item.type;
    }),
    ["user", "model", "user"],
  );
});
