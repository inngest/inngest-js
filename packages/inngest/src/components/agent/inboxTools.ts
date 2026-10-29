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
 * A reader of the messages of one listened event: it has a cursor of its own,
 * so reading never takes a message from the conversation, the other listeners
 * or the loop's steering.
 */
export interface InboxToolView {
  next: (options: {
    timeout: number | string;
  }) => Promise<InboxToolMessage | null | undefined>;
  unread: () => Promise<InboxToolMessage[]>;
  current: () => Promise<InboxToolMessage[]>;
}

/**
 * What the tools need of the thread's inbox: `inbox.listen()` and
 * `inbox.of()`.
 */
export interface InboxToolInbox {
  listen: (
    event: string | EventType<string, never>,
    options: { thread: string; if?: string },
  ) => Promise<{ stop: () => Promise<void> }>;
  of: (event: string | EventType<string, never>) => InboxToolView;
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
 * An expression with a line break or other control character, a comment (`//`
 * or `#` outside a string), a quoted identifier, a raw string or a triple-quoted string is refused,
 * since this check would read it differently from the evaluator.
 */
export const isWrappable = (expression: string): boolean => {
  if (/[\u0000-\u001f]/.test(expression)) {
    return false;
  }

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
      const before = expression.slice(0, at);

      if (
        expression.startsWith(char.repeat(3), at) ||
        /(?:^|[^A-Za-z0-9_])(?:r[b]?|b?r)$/i.test(before)
      ) {
        return false;
      }

      quote = char;
    } else if (
      char === "#" ||
      char === "`" ||
      (char === "/" && expression[at + 1] === "/")
    ) {
      return false;
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
 * - `inbox_wait({ timeout, as? })` waits for the next message of a listener's
 *   event and returns it, or says that nothing came. In `run_code` it
 *   suspends the script like any waiting tool, so the wait can be long.
 * - `inbox_read({ as?, all? })` returns what has arrived since the last read,
 *   without waiting (`view.unread()`). With `all` it returns the latest 20 of
 *   everything so far, without moving the read position (`view.current()`).
 * - `inbox_stop({ as })` stops a listener.
 *
 * A message returns marked with `agent.untrusted()`, since it came from
 * outside. `inbox_wait` and `inbox_read` read the messages of the event a
 * listener listens to through a view of their own, so they never take a stop,
 * a user message or a request from the loop, and a message the loop's steering
 * already handed to the model can still be read. `as` picks the listener's
 * event; the model's own `if` narrows what is saved from the moment it listens,
 * and the messages of the event already in the thread are read as they are.
 * Two listeners on one event share its messages.
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
  const names = config.listen.map(eventName);

  if (new Set(names).size !== names.length) {
    throw new Error(
      "inboxTools.listen names an event twice; list each event once",
    );
  }

  const sources = new Map(
    config.listen.map((source) => {
      return [eventName(source), source] as const;
    }),
  );
  const allowed = [...sources.keys()].join(", ") || "none";
  const listeners = new Map<
    string,
    {
      source: string;
      ready: Promise<{
        listener: { stop: () => Promise<void> };
        view: InboxToolView;
      }>;
    }
  >();
  const started = new Map<string, number>();
  // One view per event, made as soon as the first listener for it is taken
  // (before any await), so view numbers follow the order of the calls.
  const views = new Map<string, InboxToolView>();
  // The readers to use for `as`: that listener's, or every listener's.
  const viewsFor = async (as: string | undefined): Promise<InboxToolView[]> => {
    if (as !== undefined) {
      const listener = listeners.get(as);

      if (!listener) {
        throw new Error(
          `No listener named ${as}. Running: ${[...listeners.keys()].join(", ") || "none"}.`,
        );
      }

      return [(await listener.ready).view];
    }

    if (listeners.size === 0) {
      throw new Error("You are not listening to anything. Use inbox_listen.");
    }

    const ready = await Promise.all(
      [...listeners.values()].map(async (listener) => {
        return (await listener.ready).view;
      }),
    );

    // Listeners on one event share a view.
    return [...new Set(ready)];
  };

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
            `"if" must be a single-line CEL expression of at most ${maxIfChars} characters with balanced parentheses and quotes, and no control characters, comments, quoted identifiers, raw strings or triple quotes.`,
          );
        }

        // The configured filter and the model's, both of which must hold. The
        // model's was checked so that it can't close the parenthesis around it.
        const filters = [source.if, narrow].filter((filter) => {
          return filter !== undefined && filter !== "";
        });
        // Taken before the first await, so that listens made at the same time
        // can't pass the same checks.
        let view = views.get(name);

        if (!view) {
          view = inbox.of(source.event);
          views.set(name, view);
        }

        const reserved = (async () => {
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

          return { listener, view };
        })();

        started.set(name, count + 1);
        listeners.set(as, { source: name, ready: reserved });

        try {
          await reserved;
        } catch (error) {
          // Only its own entry: the name may have been stopped and taken again.
          if (listeners.get(as)?.ready === reserved) {
            listeners.delete(as);
          }
          started.set(name, (started.get(name) ?? 1) - 1);

          throw error;
        }

        return { listening: as, source: name };
      },
    }),

    inbox_wait: tool.group({
      description: `Wait for the next message of a listener to arrive, up to the timeout (at most ${String(config.maxWait ?? defaultMaxWait)}), and return it. Name the listener with "as" when you have more than one. Returns nothing if none came in time.`,
      input: z.object({
        timeout: z.union([z.string(), z.number()]),
        as: z.string().optional(),
      }),
      waits: true,
      run: async ({ timeout, as }) => {
        const ms =
          timeout === 0 ? 0 : durationToMs(timeout, { name: "timeout" });

        if (ms > maxWaitMs) {
          throw new Error(
            `inbox_wait can wait at most ${String(config.maxWait ?? defaultMaxWait)}.`,
          );
        }

        const views = await viewsFor(as);

        if (views.length > 1) {
          throw new Error(
            `You have ${views.length} listeners: say which one to wait for with "as".`,
          );
        }

        const message = await (views[0] as InboxToolView).next({ timeout: ms });

        return message ? { message: render(message) } : { message: null };
      },
    }),

    inbox_read: tool.group({
      description:
        'Return the messages your listeners have received since you last read, without waiting, each tagged with its source. Name one listener with "as". With all: true, return the latest 20 of everything received so far instead, and how many there are in all.',
      input: z.object({
        as: z.string().optional(),
        all: z.boolean().optional(),
      }),
      run: async ({ as, all }) => {
        const views = await viewsFor(as);

        if (all) {
          const everything = (
            await Promise.all(
              views.map((view) => {
                return view.current();
              }),
            )
          ).flat();

          return {
            total: everything.length,
            messages: everything.slice(-maxReadMessages).map(render),
          };
        }

        const fresh = (
          await Promise.all(
            views.map((view) => {
              return view.unread();
            }),
          )
        ).flat();

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
        await (await listener.ready).listener.stop();

        return { stopped: as };
      },
    }),
  };
};
