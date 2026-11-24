/**
 * @module
 * EXPERIMENTAL: the events a model may ask its thread to watch, and the
 * filter the thread subscribes with.
 *
 * the agent definition lists the events in `listen`.  each entry has a
 * `scope` that the developer writes.  the model can only make that scope
 * narrower.  an event that is not in the list is refused, so a model that
 * reads injected text cannot subscribe its thread to the events of other
 * users.
 */

import type { EventTypeWithAnySchema } from "../../../components/triggers/triggers.ts";
import { reservedListenEvent } from "../threads/threadProtocol.ts";
import type { RunFieldContext } from "./runField.ts";

/**
 * EXPERIMENTAL: paths into an arriving event and the values they must have,
 * such as `{ "data.number": 412 }`.  an event matches when every path has its
 * value.
 */
export type ListenWhere = Record<string, string | number | boolean>;

/**
 * EXPERIMENTAL: what a `scope` function receives.
 */
export interface ListenScopeContext<TEvent = unknown>
  extends RunFieldContext<TEvent> {
  /**
   * what the model asked for.  `event` is always one exact event name, also
   * when the entry is a pattern such as `billing/*`.
   */
  asked: {
    event: string;
    where?: ListenWhere;
    reason?: string;
  };
}

/**
 * EXPERIMENTAL: which events of a name a thread may watch.
 *
 * - a `ListenWhere` is the filter the thread always subscribes with.
 * - `"any"` lets the thread watch every event of that name in the
 *   environment.
 * - a function returns one of those two, or `false` to refuse the request.
 *   an error it throws is shown to the model as the reason.
 *
 * the function runs again on each replay of the run, so it must return the
 * same value for the same input.
 */
export type ListenScope<TEvent = unknown> =
  | ListenWhere
  | "any"
  | ((context: ListenScopeContext<TEvent>) => ListenWhere | "any" | false);

/**
 * EXPERIMENTAL: an event of a `listen` entry, as a name or an `eventType()`.
 */
export type ListenEvent = string | EventTypeWithAnySchema<string>;

/**
 * EXPERIMENTAL: one entry of an agent's `listen` list.
 *
 * @example
 * ```ts
 * listen: [
 *   {
 *     event: prReviewed,
 *     description: "A review was submitted on a pull request of this repository.",
 *     scope: ({ thread }) => {
 *       return { "data.repo": thread.key };
 *     },
 *   },
 * ],
 * ```
 */
export interface ListenSource<TEvent = unknown> {
  /**
   * the event, or a list of events that share one `scope`.  a name that ends
   * in `*`, such as `billing/*`, lets the model ask for each event whose name
   * starts with `billing/`.  the model still names one exact event, and the
   * thread subscribes to that name only.
   */
  event: ListenEvent | readonly ListenEvent[];

  /**
   * what the event means, for the model.  the `listen` tool shows it.
   */
  description?: string;

  scope: ListenScope<TEvent>;
}

/**
 * one event name or pattern of a `listen` list, checked.
 */
export interface CompiledListenSource {
  /**
   * the exact event name.  for a pattern, the text before the `*`.
   */
  name: string;
  pattern: boolean;
  description?: string;
  scope: ListenScope;
}

/**
 * what a thread subscribes with for one request of the model.
 */
export interface ResolvedListen {
  event: string;

  /**
   * the scope and the model's `where` as one filter.
   */
  if?: string;

  /**
   * the model's `where` alone.  the thread finds the subscription to drop
   * with it.
   */
  where: string;
}

/**
 * a path into an arriving event, as a model or a scope may write one.  a
 * path of another form is refused, so it never becomes part of an expression.
 */
const eventPath = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const whereTerms = (where: Record<string, unknown>): string[] => {
  return Object.entries(where).map(([path, value]) => {
    if (!eventPath.test(path)) {
      throw new Error(
        `"${path}" is not a path into an event: write it as \`data.number\` or \`name\`.`,
      );
    }

    return `async.${path} == ${
      typeof value === "string" ? JSON.stringify(value) : String(value)
    }`;
  });
};

/**
 * the subscription filter for paths and values.  a subscription sees the
 * arriving event as `async`, so each path is read from there.
 */
export const listenFilter = (
  where: Record<string, unknown> | undefined,
): string | undefined => {
  const terms = whereTerms(where ?? {});

  return terms.length === 0 ? undefined : terms.join(" && ");
};

const isWhere = (value: unknown): value is ListenWhere => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const nameOf = (event: ListenEvent): string => {
  return typeof event === "string" ? event : event.name;
};

/**
 * how a model reads one entry of the list.
 */
const shown = (source: CompiledListenSource): string => {
  return source.pattern ? `${source.name}*` : source.name;
};

/**
 * checks an agent's `listen` list and returns one item for each event name.
 * a bad entry throws when the agent is defined, not when a model first asks
 * for the event.
 */
export const compileListenSources = (
  agentId: string,
  sources: readonly ListenSource[] | undefined,
): CompiledListenSource[] => {
  const compiled: CompiledListenSource[] = [];
  const bad = (name: string, problem: string): Error => {
    return new Error(
      `Agent "${agentId}" has a \`listen\` entry for "${name}" that ${problem}`,
    );
  };

  for (const source of sources ?? []) {
    const events: readonly ListenEvent[] = Array.isArray(source.event)
      ? source.event
      : [source.event as ListenEvent];

    if (events.length === 0) {
      throw new Error(
        `Agent "${agentId}" has a \`listen\` entry with no event: give \`event\` a name, an \`eventType()\` or a list of them`,
      );
    }

    const { scope } = source;

    if (isWhere(scope)) {
      if (Object.keys(scope).length === 0) {
        throw bad(
          nameOf(events[0] as ListenEvent),
          'has an empty `scope`: write the paths and values an event must have, or `"any"` to let the thread watch every event of that name',
        );
      }

      // throws on a path that is not a path into an event.
      whereTerms(scope);
    } else if (scope !== "any" && typeof scope !== "function") {
      throw bad(
        nameOf(events[0] as ListenEvent),
        'has no `scope`: write the paths and values an event must have, a function that returns them, or `"any"`',
      );
    }

    for (const event of events) {
      const written = nameOf(event);
      const pattern = written.endsWith("*");
      const name = pattern ? written.slice(0, -1) : written;

      if (name === "" || name.includes("*")) {
        throw bad(
          written,
          "is not an event name: a `*` is only allowed at the end, after the start of a name, as in `billing/*`",
        );
      }

      if (reservedListenEvent(name)) {
        throw bad(
          written,
          "is reserved: the events of the agent layer (`agent/`) and of the platform (`inngest/`) cannot be watched",
        );
      }

      const again = compiled.some((one) => {
        return one.name === name && one.pattern === pattern;
      });

      if (again) {
        throw bad(written, "is there twice: list each event once");
      }

      compiled.push({
        name,
        pattern,
        ...(source.description !== undefined && {
          description: source.description,
        }),
        scope: scope as ListenScope,
      });
    }
  }

  return compiled;
};

/**
 * the entry for an event name.  an exact name is used before a pattern, and
 * the pattern with the longest start is used before a shorter one.
 */
const sourceFor = (
  sources: readonly CompiledListenSource[],
  event: string,
): CompiledListenSource | undefined => {
  const exact = sources.find((source) => {
    return !source.pattern && source.name === event;
  });

  if (exact) {
    return exact;
  }

  return sources
    .filter((source) => {
      return source.pattern && event.startsWith(source.name);
    })
    .sort((a, b) => {
      return b.name.length - a.name.length;
    })[0];
};

/**
 * the events a model may watch, as one line of text for the `listen` tool.
 */
export const listenSourcesText = (
  sources: readonly CompiledListenSource[],
): string => {
  return sources
    .map((source) => {
      const what = source.pattern
        ? `\`${shown(source)}\` (any one event whose name starts with \`${source.name}\`; name the event itself)`
        : `\`${shown(source)}\``;

      // the caller ends the list with a period.
      const description = source.description?.trim().replace(/\.$/, "");

      return description ? `${what}: ${description}` : what;
    })
    .join("; ");
};

/**
 * turns one request of the model into what the thread subscribes with.  it
 * throws an error the model can act on when the event is not in the list,
 * the scope refuses the request, or the model's `where` changes a path the
 * scope sets.  without this check a model could subscribe its thread to each
 * event in the environment.
 */
export const resolveListen = (
  sources: readonly CompiledListenSource[],
  context: RunFieldContext,
  asked: ListenScopeContext["asked"],
): ResolvedListen => {
  const { event } = asked;

  if (event.includes("*")) {
    throw new Error(
      `"${event}" is a pattern, and your thread watches one event at a time: name the event itself.`,
    );
  }

  const source = reservedListenEvent(event)
    ? undefined
    : sourceFor(sources, event);

  if (!source) {
    throw new Error(
      `Your thread cannot watch "${event}". It can watch: ${listenSourcesText(sources)}.`,
    );
  }

  const where = asked.where ?? {};
  const own = whereTerms(where);
  const scope =
    typeof source.scope === "function"
      ? source.scope({
          ...context,
          asked,
        })
      : source.scope;

  if (scope === "any") {
    return {
      event,
      ...(own.length > 0 && { if: own.join(" && ") }),
      where: own.join(" && "),
    };
  }

  if (!isWhere(scope)) {
    throw new Error(
      `Your thread does not watch "${event}" as you asked for it. Change \`where\`, or carry on without it.`,
    );
  }

  if (Object.keys(scope).length === 0) {
    throw new Error(
      `Your thread cannot watch "${event}": the \`scope\` of its \`listen\` entry returned no paths. This is a fault in the agent's definition, not in what you asked.`,
    );
  }

  const fixed = whereTerms(scope);
  const changed = Object.keys(where).find((path) => {
    return Object.hasOwn(scope, path) && scope[path] !== where[path];
  });

  if (changed !== undefined) {
    throw new Error(
      `You cannot set "${changed}" for "${event}": your thread sets it, and only brings you the events it is allowed to. Leave "${changed}" out of \`where\`.`,
    );
  }

  const added = whereTerms(
    Object.fromEntries(
      Object.entries(where).filter(([path]) => {
        return !Object.hasOwn(scope, path);
      }),
    ),
  );

  return {
    event,
    if: [...fixed, ...added].join(" && "),
    where: own.join(" && "),
  };
};
