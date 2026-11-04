/**
 * @module
 * Tests for what the run's wiring does with questions and answers before the
 * model sees them: a question that already has a reply is skipped, and an
 * answer is shown once.
 */
import { QuestionBook } from "../inbox/questionBook.ts";
import type { AgentEvent } from "../loop/loop.ts";
import { createLoopWiring } from "./loopWiring.ts";

const wiringFor = (questions: QuestionBook, events: AgentEvent[]) => {
  return createLoopWiring({
    config: { id: "bot" },
    inbox: {
      drain: async () => {
        return events;
      },
    },
    view: (() => {
      throw new Error("no named inboxes");
    }) as never,
    named: new Map(),
    limits: { limits: {}, used: { input: 0, output: 0 } },
    recorder: {} as never,
    threadKey: "t1",
    questions,
    remember: true,
    agent: "app/bot",
  });
};

const answer = (re: string) => {
  return { name: "agent/answer", data: { re, outcome: "answered", text: "x" } };
};

describe("the run's wiring", () => {
  test("shows an answer once and drops a second one", async () => {
    const wiring = wiringFor(new QuestionBook(), [
      answer("q1"),
      answer("q1"),
    ] as never);

    expect(await wiring.drain?.({ turn: 1 })).toHaveLength(1);
  });

  test("says a question has a reply once code or the model answered it", () => {
    const book = new QuestionBook();
    const wiring = wiringFor(book, []);

    expect(wiring.answered?.("q1")).toBe(false);

    book.markReplied("q1");

    expect(wiring.answered?.("q1")).toBe(true);
  });

  test("gives the text of the questions the model asked", () => {
    const book = new QuestionBook();

    book.ask("q2", "tests pass?");

    expect([...(wiringFor(book, []).questions?.() ?? [])]).toEqual([
      ["q2", "tests pass?"],
    ]);
  });
});
