/**
 * @module
 * Type and shape tests for the question, answer and finished events agents
 * and code exchange.
 */
import { expectTypeOf, test } from "vitest";
import {
  type AgentAnswerData,
  type AgentFinishedData,
  type AgentQuestionData,
  agentAnswer,
  agentFinished,
  agentMessage,
  agentQuestion,
} from "./events.ts";
import { inflightOf } from "./threadInbox.ts";

test("the event names are agent/question, agent/answer and agent/finished", () => {
  expect(agentQuestion.name).toBe("agent/question");
  expect(agentAnswer.name).toBe("agent/answer");
  expect(agentFinished.name).toBe("agent/finished");
});

test("agent/question has an id and a text", () => {
  expectTypeOf<AgentQuestionData["id"]>().toBeString();
  expectTypeOf<AgentQuestionData["text"]>().toBeString();
});

test("agent/answer narrows by outcome", () => {
  const answer = {} as AgentAnswerData;

  if (answer.outcome === "answered") {
    expectTypeOf(answer.text).toBeString();
  } else {
    expectTypeOf(answer.outcome).toEqualTypeOf<"refused" | "timed_out">();
    expectTypeOf(answer).not.toHaveProperty("text");
  }

  expectTypeOf(answer.re).toBeString();
});

test("agent/finished narrows by outcome", () => {
  const finished = {} as AgentFinishedData;

  if (finished.outcome === "failed") {
    expectTypeOf(finished.error).toBeString();
  }

  if (finished.outcome === "completed") {
    expectTypeOf(finished).toHaveProperty("output");
  }

  if (finished.outcome === "stopped") {
    expectTypeOf(finished).not.toHaveProperty("error");
  }
});

test("agent/message carries JSON content and a sender with a depth", async () => {
  const message = agentMessage.create({
    agent: "app/bot",
    thread: "t1",
    content: { plan: ["a", "b"] },
    from: { kind: "agent", address: "app/lead", key: "k1", depth: 2 },
  });

  await expect(message.validate()).resolves.toBeUndefined();
  expect((message.data as { from?: unknown }).from).toEqual({
    kind: "agent",
    address: "app/lead",
    key: "k1",
    depth: 2,
  });
});

test("a turn in flight keeps JSON content, as a failed run resends it", () => {
  expect(
    inflightOf({
      name: "agent/message",
      data: { agent: "app/bot", thread: "t1", content: { n: 1 } },
    }),
  ).toEqual({ content: { n: 1 } });
});
