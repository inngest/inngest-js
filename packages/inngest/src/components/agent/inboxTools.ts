/**
 * @module
 * EXPERIMENTAL: Tools that let a model listen for events while it works. The
 * model starts a listener on a source you allow, carries on, and is told when
 * something arrives (the loop steers it at the next safe point) or waits for
 * it. Nothing is on unless you configure `inboxTools`, and the model can only
 * use what you list: each source fixes the `thread` it listens on, and the
 * model's own `if` can only narrow it.
 */
import { z } from "zod/v4";
import { durationToMs } from "../../helpers/duration.ts";
import type { SandboxTool } from "../sandbox/tools.ts";
import { tool } from "../sandbox/tools.ts";
import type { EventType } from "../triggers/triggers.ts";
import { untrusted } from "./modelErrors.ts";

/**
 * One event the model may listen for.
 */
export interface InboxToolSource {
  /**
   * The event, by name or `eventType()`. The model names it by its name.
   */
  event: string | EventType<string, never>;

  /**
   * CEL over `event` that maps it to this run's thread key. Fixed by you: the
   * model cannot change which thread it hears.
   */
  thread: string;

  /**
   * CEL over `event` that every message must pass. The model's own `if` is
   * ANDed with it.
   */
  if?: string;

  /**
   * The most listeners the model may start on this source in a run. Default
   * unlimited, up to `maxListeners`.
   */
  maxPerRun?: number;
}

export interface InboxToolsConfig {
  /**
   * The sources the model may listen to. Anything else is a tool error that
   * names these.
   */
  listen: InboxToolSource[];

  /**
   * The most listeners the model may have running at once. Default 5.
   */
  maxListeners?: number;

  /**
   * The longest one `inbox_wait` may wait, as milliseconds or a duration
   * string. Default `"30m"`.
   */
  maxWait?: number | string;
}

/**
 * A message as the tools read it.
 */
export interface InboxToolMessage {
  name: string;
  data?: unknown;
}

/**
 * What the tools need of an inbox: `inbox.listen`, `next`, `unread` and `current`.
 */
export interface InboxToolInbox {
  listen: (
    event: string | EventType<string, never>,
    options: { thread: string; if?: string },
  ) => Promise<{ stop: () => Promise<void> }>;
  next: (options: {
    timeout: number | string;
  }) => Promise<InboxToolMessage | null | undefined>;
  unread: () => Promise<InboxToolMessage[]>;
  current: () => Promise<InboxToolMessage[]>;
}

export type InboxToolName =
  | "inbox_listen"
  | "inbox_wait"
  | "inbox_read"
  | "inbox_stop";

const defaultMaxListeners = 5;
const defaultMaxWait = "30m";
const maxMessageChars = 4_000;
const maxIfChars = 500;
const maxReadMessages = 20;

const eventName = (source: InboxToolSource): string => {
  return typeof source.event === "string" ? source.event : source.event.name;
};

/**
 * Whether the parentheses and quotes of a CEL expression balance, so that
 * wrapping it as `(<expression>)` cannot be closed early by the expression.
 */
export const isWrappable = (expression: string): boolean => {
  let depth = 0;
  let quote: string | undefined;

  for (let at = 0; at < expression.length; at += 1) {
    const char = expression[at] as string;

    if (quote) {
      if (char === "\\") {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;

      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0 && quote === undefined;
};

const render = (message: InboxToolMessage) => {
  const text = JSON.stringify(message.data ?? null) ?? "null";
  const clipped =
    text.length > maxMessageChars
      ? `${text.slice(0, maxMessageChars)}... (${text.length - maxMessageChars} more characters)`
      : text;

  return {
    source: message.name,
    content: untrusted(clipped, { source: message.name }),
  };
};

/**
 * EXPERIMENTAL: The model-facing inbox tools for `inbox`, as `inbox_listen`,
 * `inbox_wait`, `inbox_read` and `inbox_stop`. An agent with `inboxTools` in
 * its config gets them as `inboxTools` in its body; pass them to `agent.loop()`
 * as `tools: { ...inboxTools }`, and to `sandbox.tools.code({ tools })` to give
 * `run_code` scripts the same inbox under the same allowlist.
 *
 * - `inbox_listen({ source, if?, as })` starts listening in the background to
 *   an allowed source. `as` names the listener.
 * - `inbox_wait({ timeout })` waits for the next message and returns it, or
 *   says that nothing came. In `run_code` it suspends the script like any
 *   waiting tool, so the wait can be long.
 * - `inbox_read({ all? })` returns what has arrived since the last read,
 *   without waiting (`inbox.unread()`). With `all` it returns the latest 20 of
 *   everything so far, without moving the read position (`inbox.current()`).
 * - `inbox_stop({ as })` stops a listener.
 *
 * A message returns marked with `agent.untrusted()`, since it came from
 * outside. `inbox_wait` and `inbox_read` return the next messages of the whole
 * inbox, tagged by `source`, not only one listener's. The loop's steering
 * hands the model what arrives between model calls.
 *
 * @example
 * ```ts
 * const tools = createInboxTools(inbox, {
 *   listen: [{ event: "github/check_run", thread: "event.data.thread" }],
 *   maxWait: "20m",
 * });
 * ```
 */
export const createInboxTools = (
  inbox: InboxToolInbox,
  config: InboxToolsConfig,
): Record<InboxToolName, SandboxTool> => {
  const maxListeners = config.maxListeners ?? defaultMaxListeners;
  const maxWaitMs = durationToMs(config.maxWait ?? defaultMaxWait, {
    name: "inboxTools.maxWait",
  });
  const sources = new Map(
    config.listen.map((source) => {
      return [eventName(source), source] as const;
    }),
  );
  const allowed = [...sources.keys()].join(", ") || "none";
  const listeners = new Map<
    string,
    { source: string; stop: () => Promise<void> }
  >();
  const started = new Map<string, number>();

  return {
    inbox_listen: tool.group({
      description: `Start listening in the background for events from a source, and carry on with your work. What arrives is handed to you at your next turn, or read it with inbox_wait or inbox_read. Sources: ${allowed}. Give "if" (CEL over event, such as event.data.pr == 12) to narrow what you hear, and "as" to name the listener.`,
      input: z.object({
        source: z.string(),
        if: z.string().optional(),
        as: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
      }),
      run: async ({ source: name, if: narrow, as }) => {
        const source = sources.get(name);

        if (!source) {
          throw new Error(
            `${name} is not a source you can listen to. Allowed: ${allowed}.`,
          );
        }

        if (listeners.has(as)) {
          throw new Error(`A listener named ${as} is already running.`);
        }

        if (listeners.size >= maxListeners) {
          throw new Error(
            `Already listening ${maxListeners} times. Stop one with inbox_stop first.`,
          );
        }

        const count = started.get(name) ?? 0;

        if (source.maxPerRun !== undefined && count >= source.maxPerRun) {
          throw new Error(
            `${name} can be listened to ${source.maxPerRun} times in a run and already was.`,
          );
        }

        if (
          narrow !== undefined &&
          (narrow.length > maxIfChars || !isWrappable(narrow))
        ) {
          throw new Error(
            `"if" must be a CEL expression of at most ${maxIfChars} characters with balanced parentheses and quotes.`,
          );
        }

        // The configured filter and the model's, both of which must hold. The
        // model's was checked to balance its parentheses and quotes, so it
        // can't close the one around it.
        const filters = [source.if, narrow].filter((filter) => {
          return filter !== undefined && filter !== "";
        });
        const listener = await inbox.listen(source.event, {
          thread: source.thread,
          ...(filters.length > 0 && {
            if: filters
              .map((filter) => {
                return `(${filter})`;
              })
              .join(" && "),
          }),
        });

        started.set(name, count + 1);
        listeners.set(as, { source: name, stop: listener.stop });

        return { listening: as, source: name };
      },
    }),

    inbox_wait: tool.group({
      description: `Wait for the next message to arrive, up to the timeout (at most ${String(config.maxWait ?? defaultMaxWait)}), and return it. Returns nothing if none came in time. Messages come from every listener and from the conversation, each tagged with its source.`,
      input: z.object({ timeout: z.union([z.string(), z.number()]) }),
      waits: true,
      run: async ({ timeout }) => {
        const ms =
          timeout === 0 ? 0 : durationToMs(timeout, { name: "timeout" });

        if (ms > maxWaitMs) {
          throw new Error(
            `inbox_wait can wait at most ${String(config.maxWait ?? defaultMaxWait)}.`,
          );
        }

        const message = await inbox.next({ timeout: ms });

        return message ? { message: render(message) } : { message: null };
      },
    }),

    inbox_read: tool.group({
      description:
        "Return the messages that have arrived on the conversation and your listeners since you last read, without waiting. Each is tagged with its source. With all: true, return the latest 20 of everything so far instead, and how many there are in all.",
      input: z.object({ all: z.boolean().optional() }),
      run: async ({ all }) => {
        if (all) {
          const everything = await inbox.current();

          return {
            total: everything.length,
            messages: everything.slice(-maxReadMessages).map(render),
          };
        }

        const fresh = await inbox.unread();

        return { messages: fresh.map(render) };
      },
    }),

    inbox_stop: tool.group({
      description: "Stop a listener you started with inbox_listen.",
      input: z.object({ as: z.string() }),
      run: async ({ as }) => {
        const listener = listeners.get(as);

        if (!listener) {
          throw new Error(
            `No listener named ${as}. Running: ${[...listeners.keys()].join(", ") || "none"}.`,
          );
        }

        listeners.delete(as);
        await listener.stop();

        return { stopped: as };
      },
    }),
  };
};
