/**
 * @module
 * EXPERIMENTAL: the tools that let a model start watching for events while it
 * works: `inbox_listen` and `inbox_close`. They exist only for an agent whose
 * `listen` is non-empty, and the model can only listen to the event types
 * listed there. The model never writes an expression: it gives a map of fields
 * under the event's `data` to the values they must equal, and the SDK builds
 * the `if` of the inbox's source.
 */
import { z } from "zod/v4";
import type { SandboxTool } from "../../../components/sandbox/tools.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import type { EventTypeWithAnySchema } from "../../../components/triggers/triggers.ts";
import { untrustedText } from "../loop/untrustedText.ts";

/**
 * A message as the tools hand it back when an inbox closes.
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
 * An inbox the model opened with `inbox_listen`.
 */
export interface InboxToolOpened {
  /**
   * Ends the inbox. Messages it did not read are returned.
   */
  close: () => Promise<InboxToolMessage[]>;
}

/**
 * What the tools need of the thread: a way to open a named inbox.
 */
export interface InboxToolInbox {
  /**
   * Opens a new inbox named `as` on one event type: the events that pass
   * `if`, and belong to this thread when the agent has a `thread` expression.
   * It is one `step.subscribe`, with an ID made from `as`.
   */
  open: (
    as: string,
    event: EventTypeWithAnySchema<string>,
    options: { if?: string },
  ) => Promise<InboxToolOpened>;
}

/**
 * The names of the model's inbox tools.
 */
export type InboxToolName = "inbox_listen" | "inbox_close";

/**
 * What `inbox_listen` takes, for the event types in `listen`.
 */
export interface InboxListenInput<TName extends string = string> {
  /**
   * The name of a listed event type.
   */
  source: TName;

  /**
   * Fields under the event's `data` and the values they must equal, such as
   * `{ "pull_request.number": 12 }`. At most 8.
   */
  match?: Record<string, string | number | boolean>;

  /**
   * The name of the inbox.
   */
  as: string;
}

/**
 * The model's inbox tools for an agent whose `listen` is `T`: none when `T` is
 * empty, and `inbox_listen` typed from the names in `T` with `inbox_close`
 * otherwise.
 */
export type InboxToolsOf<T extends readonly EventTypeWithAnySchema<string>[]> =
  [T[number]] extends [never]
    ? Record<never, never>
    : {
        inbox_listen: SandboxTool<InboxListenInput<T[number]["name"]>, unknown>;
        inbox_close: SandboxTool<{ as: string }, unknown>;
      };

const maxListeners = 5;
const maxPerRun = 3;
const maxMatchFields = 8;
const maxMatchValueChars = 200;
const maxMatchKeyChars = 128;

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
 * The CEL for a `match` map: each key is a path under the event's `data`
 * (`user`, or `pull_request.number` for a nested field) that must equal its
 * value, all of them ANDed. The SDK writes every part, so
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
        path.length > maxMatchKeyChars ||
        !fieldPath.test(path) ||
        path.split(".").some((part) => {
          return reservedWords.has(part);
        })
      ) {
        throw new Error(
          `"match" key ${JSON.stringify(path)} must be a field path under the event's data such as pull_request.number, at most ${maxMatchKeyChars} characters.`,
        );
      }

      return `async.data.${path} == ${literal(value)}`;
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
    content: untrustedText(clipped, { source: message.name }),
  };
};

const maxMessageChars = 4_000;

/**
 * The model's `inbox_listen` and `inbox_close` for the event types in
 * `listen`.
 *
 * - `inbox_listen({ source, match?, as })` opens a new inbox named `as` on a
 *   listed event type, and carries on. `match` maps fields under the event's
 *   `data` (`"pull_request.number"`) to the values they must equal; the SDK
 *   builds the `if`, so the model's input is never parsed as an expression. A
 *   type outside `listen` is refused with a message that names the ones that
 *   are allowed.
 * - `inbox_close({ as })` closes an inbox it opened.
 * @param inbox How to open a named inbox.
 * @param listen The event types the model may listen to.
 */
export const createListenTools = <
  const TListen extends readonly EventTypeWithAnySchema<string>[],
>(
  inbox: InboxToolInbox,
  listen: TListen,
): InboxToolsOf<TListen> => {
  const names = listen.map((type) => {
    return type.name;
  });

  if (new Set(names).size !== names.length) {
    throw new Error("listen names an event type twice; list each type once");
  }

  const sources = new Map(
    listen.map((type) => {
      return [type.name, type] as const;
    }),
  );
  const allowed = names.join(", ") || "none";
  const opened = new Map<
    string,
    { source: string; ready: Promise<InboxToolOpened> }
  >();
  const started = new Map<string, number>();

  const tools = {
    inbox_listen: tool.group({
      description: `Open a new inbox on an event type and carry on with your work. What arrives is handed to you at your next turn. Sources: ${allowed}. Give "match" (fields under the event's data and the values they must equal, such as { "pull_request.number": 12 }, at most ${maxMatchFields} fields) to narrow what you hear, and "as" to name the inbox.`,
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

        if (opened.has(as)) {
          throw new Error(`An inbox named ${as} is already open.`);
        }

        if (opened.size >= maxListeners) {
          throw new Error(
            `Already ${maxListeners} inboxes open. Close one with inbox_close first.`,
          );
        }

        const count = started.get(name) ?? 0;

        if (count >= maxPerRun) {
          throw new Error(
            `${name} can be listened to ${maxPerRun} times in a run and already was.`,
          );
        }

        // Built before anything is reserved, so a bad match changes nothing.
        const narrow = match === undefined ? undefined : matchToCel(match);

        // Reserved before the first await, so that opens made at the same time
        // can't pass the same checks.
        const reserved = inbox.open(as, source, {
          ...(narrow !== undefined && { if: narrow }),
        });

        started.set(name, count + 1);
        opened.set(as, { source: name, ready: reserved });

        try {
          await reserved;
        } catch (error) {
          // Only its own entry: the name may have been closed and taken again.
          if (opened.get(as)?.ready === reserved) {
            opened.delete(as);
          }
          started.set(name, (started.get(name) ?? 1) - 1);

          throw error;
        }

        return { listening: as, source: name };
      },
    }),

    inbox_close: tool.group({
      description: "Close an inbox you opened with inbox_listen.",
      input: z.object({ as: z.string() }),
      run: async ({ as }) => {
        const found = opened.get(as);

        if (!found) {
          throw new Error(
            `No inbox named ${as}. Open: ${[...opened.keys()].join(", ") || "none"}.`,
          );
        }

        opened.delete(as);
        const unread = await (await found.ready).close();

        return {
          closed: as,
          ...(unread.length > 0 && { unread: unread.map(render) }),
        };
      },
    }),
  };

  // One cast: the tools are made over plain strings; the type narrows them to
  // the names in `listen`.
  return tools as unknown as InboxToolsOf<TListen>;
};
