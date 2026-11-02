/**
 * @module
 * EXPERIMENTAL: what one run of a model agent knows about questions. It keeps
 * the questions the agent received (so the `reply` tool can answer one by its
 * id), the ones it answered (so the loop spends no turn on a question that
 * already has a reply), and the ones it asked with `ask_agent` (so an answer
 * is shown next to its question, and a second answer to one is dropped).
 */

import type { QuestionRef } from "./answer.ts";

/**
 * The question and answer messages of a run.
 */
export class QuestionBook {
  private readonly received = new Map<string, QuestionRef>();
  private readonly replied = new Set<string>();
  private readonly asked = new Map<string, string>();
  private readonly closed = new Set<string>();

  /**
   * Notes a question that reached the inbox.
   */
  receive(data: QuestionRef["data"]): void {
    this.received.set(data.id, { data });
  }

  /**
   * A question that reached the inbox, by its ID.
   */
  question(id: string): QuestionRef | undefined {
    return this.received.get(id);
  }

  /**
   * Notes that the question was answered, by code or by the model.
   */
  markReplied(id: string): void {
    this.replied.add(id);
  }

  /**
   * Whether the question already has a reply.
   */
  isReplied(id: string): boolean {
    return this.replied.has(id);
  }

  /**
   * Notes a question the model asked with `ask_agent`.
   */
  ask(id: string, text: string): void {
    this.asked.set(id, text);
  }

  /**
   * The text of the questions the model asked, by ID.
   */
  texts(): ReadonlyMap<string, string> {
    return this.asked;
  }

  /**
   * Whether a message may reach the model. An `agent/answer` is let through
   * once per question; a second one, or a late one, is dropped.
   */
  admit(event: { name: string; data?: unknown }): boolean {
    if (event.name !== "agent/answer") {
      return true;
    }

    const re = (event.data as { re?: unknown } | undefined)?.re;

    if (typeof re !== "string") {
      return true;
    }

    if (this.closed.has(re)) {
      return false;
    }

    this.closed.add(re);

    return true;
  }
}
