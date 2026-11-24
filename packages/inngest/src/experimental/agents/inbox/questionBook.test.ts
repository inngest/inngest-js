/**
 * @module
 * Tests for what a model agent's run knows about questions: the ones it
 * received, the ones it answered, and the ones it asked. A question is
 * answered once, and an answer to a question that is already closed is
 * dropped.
 */
import { QuestionBook } from "./questionBook.ts";

const asker = { kind: "agent" as const, address: "app/a", key: "t1" };

describe("QuestionBook", () => {
  test("remembers a received question until it is answered", () => {
    const book = new QuestionBook();

    book.receive({ id: "q1", text: "ready?", from: asker });

    expect(book.question("q1")).toEqual({
      data: { id: "q1", text: "ready?", from: asker },
    });
    expect(book.isReplied("q1")).toBe(false);

    book.markReplied("q1");

    expect(book.isReplied("q1")).toBe(true);
  });

  test("an unknown question is undefined", () => {
    expect(new QuestionBook().question("nope")).toBeUndefined();
  });

  test("shows the text of the questions the model asked", () => {
    const book = new QuestionBook();

    book.ask("q2", "tests pass?");

    expect([...book.texts()]).toEqual([["q2", "tests pass?"]]);
  });

  test("the first answer to a question the model asked is admitted, a second is not", () => {
    const book = new QuestionBook();

    book.ask("q2", "tests pass?");

    expect(book.admit({ name: "agent/answer", data: { re: "q2" } })).toBe(true);
    expect(book.admit({ name: "agent/answer", data: { re: "q2" } })).toBe(
      false,
    );
  });

  test("an answer to a question this run did not ask is admitted once", () => {
    const book = new QuestionBook();

    expect(book.admit({ name: "agent/answer", data: { re: "old" } })).toBe(
      true,
    );
    expect(book.admit({ name: "agent/answer", data: { re: "old" } })).toBe(
      false,
    );
  });

  test("anything but an agent/answer is admitted", () => {
    expect(
      new QuestionBook().admit({ name: "agent/message", data: { re: "q" } }),
    ).toBe(true);
  });
});
