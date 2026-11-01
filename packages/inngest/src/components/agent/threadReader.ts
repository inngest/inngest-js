/**
 * @module
 * The reads an agent's body has on its inbox, made from the reads of an
 * `Inbox` (`../inbox/Inbox.ts`). An agent reads `next()` with the old
 * conventions (`null` once closed, `undefined` on a timeout), takes what is
 * `unread()`, looks at what is `current()` and puts messages back. The `Inbox`
 * keeps a position per reader and records nothing but its reads, so what a
 * put-back needs lives here: the messages a reader holds to return before
 * anything newer. Every replay makes the same reads and puts the same messages
 * back, so what a reader holds is rebuilt, not saved.
 */
import type { ReadTimeout } from "../inbox/Inbox.ts";
import type { NextOptions } from "./inboxMessage.ts";

/**
 * What a reader needs of an `Inbox` or a view of one.
 */
export interface InboxReader<TMessage> {
  next(options?: { timeout: ReadTimeout }): Promise<TMessage | null | undefined>;
  drain(): Promise<TMessage[]>;
  close(): Promise<TMessage[]>;
  readonly closed: boolean;
}

/**
 * Whether a timeout is zero: a read that never waits.
 */
const isZero = (timeout: NextOptions["timeout"]): boolean => {
  return timeout === 0 || timeout === "0" || timeout === "0s";
};

/**
 * A reader of an inbox with the reads of an agent's body.
 */
export class ThreadReader<TMessage extends object> {
  #source: InboxReader<TMessage>;

  // Messages to return before anything the source has: those put back, and the
  // event that started the run.
  #held: TMessage[];

  // Every message the source has handed over, in order.
  #seen: TMessage[] = [];

  // Messages taken from the source so far: the next one's `seq` is this plus 1.
  #taken = 0;

  constructor(source: InboxReader<TMessage>, held: TMessage[] = []) {
    this.#source = source;
    this.#held = [...held];
  }

  /**
   * Takes everything the source has without waiting, and remembers it.
   */
  async #fetch(): Promise<TMessage[]> {
    const messages = (await this.#source.drain()).map((message) => {
      return this.#number(message);
    });
    this.#seen.push(...messages);

    return messages;
  }

  /**
   * A copy of a message that says where in this reader it came. The message
   * the source hands over is shared with every other reader.
   */
  #number(message: TMessage): TMessage {
    this.#taken += 1;

    return { ...message, seq: this.#taken };
  }

  /**
   * The next message, `null` once the inbox is closed and every message is
   * read, and with a timeout `undefined` when none arrived in time.
   */
  async next(options?: NextOptions): Promise<TMessage | null | undefined> {
    const held = this.#held.shift();
    if (held !== undefined) {
      return held;
    }

    const timeout = options?.timeout;

    if (timeout !== undefined && isZero(timeout)) {
      const [first, ...rest] = await this.#fetch();
      this.#held.push(...rest);

      if (first !== undefined) {
        return first;
      }

      return this.#source.closed ? null : undefined;
    }

    const message =
      timeout === undefined
        ? await this.#source.next()
        : await this.#source.next({ timeout: timeout as ReadTimeout });

    if (message === undefined) {
      return null;
    }

    if (message === null) {
      return undefined;
    }

    const numbered = this.#number(message);
    this.#seen.push(numbered);

    return numbered;
  }

  /**
   * Everything not yet read, in order, without waiting.
   */
  async unread(): Promise<TMessage[]> {
    const held = this.#held.splice(0);

    return [...held, ...(await this.#fetch())];
  }

  /**
   * Every message the inbox has received so far, read or not, in order. It
   * moves no position: what is not read yet is returned by the next reads.
   */
  async current(): Promise<TMessage[]> {
    this.#held.push(...(await this.#fetch()));

    return [...this.#seen];
  }

  /**
   * Puts messages back so the next reads return them before anything newer.
   */
  putBack(messages: TMessage[]): void {
    this.#held.unshift(...messages);
  }

  /**
   * Closes the inbox. Returns what had not been read.
   */
  async close(): Promise<TMessage[]> {
    const held = this.#held.splice(0);

    return [...held, ...(await this.#source.close())];
  }
}
