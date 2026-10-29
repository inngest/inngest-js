/**
 * @module
 * EXPERIMENTAL: Tools that let a model listen for events while it works. The
 * model starts a listener on a source you allow, carries on, and is told when
 * something arrives (the loop steers it at the next safe point) or waits for
 * it. Nothing is on unless you configure `inboxTools`, and the model can only
 * use what you list: each source fixes the `thread` it listens on, and the
 * model's own `match` can only narrow it. The model never writes CEL: it gives a
 * map of event fields to values and the SDK builds the expression.
 */
import { z } from "zod/v4";
import { durationToMs } from "../../helpers/duration.ts";
import type { SandboxTool } from "../sandbox/tools.ts";
import { tool } from "../sandbox/tools.ts";
import type { EventTypeWithAnySchema } from "../triggers/triggers.ts";
import { untrusted } from "./modelErrors.ts";

/**
 * One event the model may listen for.
 */
export interface InboxToolSource {
  /**
   * The event, by name or `eventType()`. The model names it by its name.
   */
  event: string | EventTypeWithAnySchema<string>;

  /**
   * CEL over `event` that maps it to this run's thread key. Fixed by you: the
   * model cannot change which thread it hears.
   */
  thread: string;

  /**
   * CEL over `event` that every message must pass. The model's `match` is
   * ANDed with it.
   */
  if?: string;

  /**
   * The most listeners the model may start on this source in a run. Stopping
   * one does not give its place back. Default 3.
   */
  maxPerRun?: number;
}

/**
 * What the model may do with its inbox tools: which sources it may listen to
 * and how much.
 */
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

  /**
   * The most the model may wait in all in a run, counting the timeout of each
   * `inbox_wait`. Default `"2h"`.
   */
  maxTotalWait?: number | string;
}

/**
 * A message as the tools read it.
 */
export interface InboxToolMessage {
  /**
   * The name of the event the message came from.
   */
  name: string;

  /**
   * The event's `data`. Shown to the model as untrusted text.
   */
  data?: unknown;
}

/**
 * A reader of the messages of one listened event: it has a cursor of its own,
 * so reading never takes a message from the conversation, the other listeners
 * or the loop's steering.
 */
export interface InboxToolView {
  /**
   * The next message after the view's read position, waiting up to `timeout`
   * for one. Nothing when none came in time.
   */
  next: (options: {
    timeout: number | string;
  }) => Promise<InboxToolMessage | null | undefined>;

  /**
   * Every message after the read position, moving the position to the end.
   */
  unread: () => Promise<InboxToolMessage[]>;

  /**
   * Every message so far, without moving the read position.
   */
  current: () => Promise<InboxToolMessage[]>;
}

/**
 * What the tools need of the thread's inbox: `inbox.listen()` and
 * `inbox.of()`.
 */
export interface InboxToolInbox {
  /**
   * Starts saving the events that pass `thread` (and `if`) to the thread's
   * inbox. `stop()` ends it.
   */
  listen: (
    event: string | EventTypeWithAnySchema<string>,
    options: { thread: string; if?: string },
  ) => Promise<{ stop: () => Promise<void> }>;

  /**
   * A reader of one event's messages with a read position of its own.
   */
  of: (event: string | EventTypeWithAnySchema<string>) => InboxToolView;
}

/**
 * The names of the four tools: the keys of `inboxTools` in an agent's body.
 */
export type InboxToolName =
  | "inbox_listen"
  | "inbox_wait"
  | "inbox_read"
  | "inbox_stop";

/**
 * The `inboxTools` an agent's body gets for its config's `inboxTools` type
 * `T`: all four tools when it is configured, none when it is not, and each
 * optional when that is not known.
 */
export type InboxToolsOf<T extends InboxToolsConfig | undefined> = [T] extends [
  undefined,
]
  ? Record<never, never>
  : undefined extends T
    ? Partial<Record<InboxToolName, SandboxTool>>
    : Record<InboxToolName, SandboxTool>;

const defaultMaxListeners = 5;
const defaultMaxWait = "30m";
const maxMessageChars = 4_000;
const maxMatchFields = 8;
const maxMatchValueChars = 200;
const defaultMaxPerRun = 3;
const defaultMaxTotalWait = "2h";
const maxReadMessages = 20;

const eventName = (source: InboxToolSource): string => {
  return typeof source.event === "string" ? source.event : source.event.name;
};

const fieldPath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const reservedWords = new Set([
  "as",
  "break",
  "const",
  "continue",
  "else",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "namespace",
  "null",
  "package",
  "return",
  "true",
  "var",
  "void",
  "while",
]);
const loneSurrogate =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A CEL literal for a value: a double-quoted string with every control and
 * line-break character escaped, or a finite number, or a boolean.
 */
const literal = (value: string | number | boolean): string => {
  if (typeof value === "string") {
    if (value.length > maxMatchValueChars) {
      throw new Error(
        `A "match" value may be at most ${maxMatchValueChars} characters.`,
      );
    }

    if (loneSurrogate.test(value)) {
      throw new Error('A "match" value must be valid text.');
    }

    return JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (char) => {
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      },
    );
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error('A "match" number must be finite.');
  }

  return String(value);
};

/**
 * The CEL for a `match` map: each key is a path in the event (`data.user`)
 * that must equal its value, all of them ANDed. The SDK writes every part, so
 * nothing the model gives can become syntax.
 */
export const matchToCel = (
  match: Record<string, string | number | boolean>,
): string | undefined => {
  const entries = Object.entries(match);

  if (entries.length > maxMatchFields) {
    throw new Error(`"match" may name at most ${maxMatchFields} fields.`);
  }

  if (entries.length === 0) {
    return undefined;
  }

  return entries
    .map(([path, value]) => {
      if (
        !fieldPath.test(path) ||
        path.split(".").some((part) => {
          return reservedWords.has(part);
        })
      ) {
        throw new Error(
          `"match" key ${JSON.stringify(path)} must be a field path of the event such as data.user.`,
        );
      }

      return `event.${path} == ${literal(value)}`;
    })
    .join(" && ");
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
 * - `inbox_listen({ source, match?, as })` starts listening in the background
 *   to an allowed source. `as` names the listener, and `match` maps event
 *   fields (`"data.user"`) to the values they must equal; the SDK builds the
 *   CEL, so the model's input is never parsed as an expression.
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
 * event; the model's `match` narrows what is saved from the moment it listens,
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
  const maxTotalWaitMs = durationToMs(
    config.maxTotalWait ?? defaultMaxTotalWait,
    { name: "inboxTools.maxTotalWait" },
  );
  // The timeouts asked for so far, which a replay asks for again in order.
  let waited = 0;
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
      description: `Start listening in the background for events from a source, and carry on with your work. What arrives is handed to you at your next turn, or read it with inbox_wait or inbox_read. Sources: ${allowed}. Give "match" (fields of the event and the values they must equal, such as { "data.pr": 12 }) to narrow what you hear, and "as" to name the listener.`,
      input: z.object({
        source: z.string(),
        match: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        as: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
      }),
      run: async ({ source: name, match, as }) => {
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

        const perRun = source.maxPerRun ?? defaultMaxPerRun;

        if (count >= perRun) {
          throw new Error(
            `${name} can be listened to ${perRun} times in a run and already was.`,
          );
        }

        // Built before anything is reserved, so a bad match changes nothing.
        const narrow = match === undefined ? undefined : matchToCel(match);
        // The configured filter and the model's, both of which must hold.
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

        if (waited + ms > maxTotalWaitMs) {
          throw new Error(
            `This run may wait ${String(config.maxTotalWait ?? defaultMaxTotalWait)} in all and has used ${Math.round(waited / 1000)} s.`,
          );
        }

        waited += ms;

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
