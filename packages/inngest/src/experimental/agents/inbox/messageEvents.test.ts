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
  agentQuestion,
} from "./events.ts";

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
