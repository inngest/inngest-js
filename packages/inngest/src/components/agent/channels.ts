/**
 * @module
 * EXPERIMENTAL: channels, the destinations of an agent: a Slack thread, a
 * pull request comment, a ticket. Progress reports and asks both go through a
 * channel. A channel is an adapter written with `defineChannel`; an agent
 * names its channels in config (a value, or a function of the trigger) and
 * the body reports to them with `report()`. This file also holds what the
 * Slack and GitHub adapters share: field validation, text limits, the HTTP
 * call and its error classes.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { NonRetriableError } from "../NonRetriableError.ts";
import type { ConfigValue } from "./defs.ts";
import { scoreThisStep } from "./scores.ts";

/**
 * A message to a channel.
 */
export interface ChannelMessage {
  /**
   * The text to post.
   */
  text: string;

  /**
   * What the message is. The Slack and GitHub adapters mark `"error"`
   * messages; `"progress"` (the default) and `"result"` look the same.
   */
  kind?: "progress" | "result" | "error";
}

/**
 * A question for a person, as a channel renders it.
 */
export interface ChannelAsk {
  /**
   * The signal the answer is sent back as. The adapter puts it wherever the
   * answer will come from (a button value, a form field) so that the route
   * that receives the answer can send it.
   */
  signal: string;
  /**
   * The question to show.
   */
  question: string;

  /**
   * The answers to offer, such as buttons. Default: none.
   */
  options?: string[];

  /**
   * The option a timeout falls back to.
   */
  recommended?: string;

  /**
   * Who may answer. The SDK enforces nothing: the adapter, or the route that
   * sends the signal, checks it.
   */
  approvers?: string[];

  /**
   * How long the ask waits, such as `"7d"`.
   */
  timeout?: string;
}

/**
 * One task card of a progress stream: a step the agent is working on, shown
 * as a line with a status. A card is identified by its `id`; writing a card
 * again with the same `id` updates it.
 */
export interface ChannelCard {
  /**
   * Names the card. Writing the same `id` again updates the card; a new `id`
   * adds one. Up to 100 characters, and not `summary`, which the reporter uses
   * for the card that stands for the cards of a stream it left.
   */
  id: string;

  /**
   * What the step is.
   */
  title: string;

  /**
   * Where the step is. Default: `"running"`.
   */
  status?: "pending" | "running" | "done" | "error";

  /**
   * More to show under the title.
   */
  details?: string;
}

/**
 * What one surface allows a progress stream to hold. The surface's adapter
 * declares it, so every agent that reports to the surface stays inside it.
 */
export interface ChannelStreamLimits {
  /**
   * The most unique cards one stream may hold. Slack: 50.
   */
  maxCards: number;

  /**
   * How many unique cards a stream holds before the reporter starts a new
   * one, with a summary card for the cards it leaves. At most
   * `maxCards - 2`, which leaves room for the summary and the new card.
   */
  rollAt: number;

  /**
   * How long a stream lives, in milliseconds, before the reporter starts a
   * new one. The surface ends streams on its own after a while; set this a
   * little under that.
   */
  maxAgeMs: number;
}

/**
 * Thrown by an adapter's `append` when the stream it was asked to write to
 * has ended (the surface closed it, or it timed out). The reporter starts a
 * new stream and writes only the card it was writing, not the history.
 */
export class ChannelStreamEnded extends Error {
  constructor(message = "The progress stream has ended.") {
    super(message);
    this.name = "ChannelStreamEnded";
  }
}

/**
 * A surface's streamed progress, such as Slack's task cards in one message.
 * The adapter is stateless: a stream is a string the adapter hands out, and
 * the reporter keeps it in step results, so a replay never starts or writes
 * to a stream twice.
 */
export interface ChannelStream {
  /**
   * What the surface allows.
   */
  limits: ChannelStreamLimits;

  /**
   * Starts a stream and returns its identity, such as a message timestamp.
   * Runs inside a step.
   */
  start(): Promise<string>;

  /**
   * Writes cards to a stream, adding the new ones and updating those that
   * exist. Runs inside a step. Throws `ChannelStreamEnded` when the stream is
   * over. A surface that answers with a warning that it dropped part of the
   * update must throw: a dropped update is an error, not a success.
   */
  append(
    /**
     * The stream `start()` returned.
     */
    stream: string,

    /**
     * The cards to write.
     */
    cards: ChannelCard[],
  ): Promise<void>;

  /**
   * Closes a stream the reporter is leaving. Optional, and best effort: its
   * failure is ignored.
   */
  stop?(
    /**
     * The stream.
     */
    stream: string,
  ): Promise<void>;
}

/**
 * How to talk to one destination.
 */
export interface Channel {
  /**
   * The channel's streamed progress, for `report.card()`. A channel without
   * one ignores cards.
   */
  stream?: ChannelStream;

  /**
   * Posts a message. Runs inside a step, so it may be retried: a post whose
   * answer is lost is posted again, so delivery is at least once.
   */
  post(
    /**
     * What to post.
     */
    message: ChannelMessage,
  ): Promise<void>;

  /**
   * Renders a question and returns once it is shown. The answer does not come
   * back from here: it arrives later as the signal `ask.signal`. A channel that
   * can post but not ask leaves this out.
   */
  ask?(
    /**
     * The question.
     */
    ask: ChannelAsk,
  ): Promise<void>;
}

/**
 * Makes a channel from an adapter.
 *
 * ```ts
 * const ticketChannel = defineChannel({
 *   post: async (message) => {
 *     await tickets.comment(message.text);
 *   },
 * });
 * ```
 */
export const defineChannel = (
  /**
   * How to post, and optionally how to render an ask.
   */
  adapter: Channel,
): Channel => {
  if (typeof adapter?.post !== "function") {
    throw new Error("A channel needs a `post` function.");
  }

  if (adapter.ask !== undefined && typeof adapter.ask !== "function") {
    throw new Error("A channel's `ask` must be a function.");
  }

  if (adapter.stream !== undefined) {
    const { limits } = adapter.stream;

    if (
      typeof adapter.stream.start !== "function" ||
      typeof adapter.stream.append !== "function" ||
      !limits ||
      !Number.isInteger(limits.maxCards) ||
      !Number.isInteger(limits.rollAt) ||
      limits.rollAt < 1 ||
      limits.rollAt > limits.maxCards - 2 ||
      !(limits.maxAgeMs > 0)
    ) {
      throw new Error(
        "A channel's `stream` needs `start`, `append` and limits with `rollAt` between 1 and `maxCards - 2` and a positive `maxAgeMs`.",
      );
    }
  }

  return adapter;
};

/**
 * Renders an ask through a channel. This is the hook `thread.ask` will call; a
 * channel without `ask` is an error that says so, never a silent skip. Call it
 * inside a step, so a replay of the run does not render the question twice.
 */
export const askThrough = async (
  /**
   * The channel to ask through.
   */
  channel: Channel,

  /**
   * The question.
   */
  ask: ChannelAsk,
): Promise<void> => {
  if (!channel.ask) {
    throw new NonRetriableError(
      "This channel cannot ask: its adapter has no `ask` function.",
    );
  }

  await channel.ask(ask);
};

/**
 * Where a report goes: the name of a channel in `channels`, or a channel
 * itself.
 */
export type ReportTarget = string | Channel;

/**
 * The `report` option of an agent config: where progress goes when `report()`
 * is not told. Default: the channel named `main`.
 */
export type ReportConfig = ReportTarget | ReportTarget[];

/**
 * A `report` config: the value, or a function of the run's context `Ctx` that
 * picks it.
 */
export type ReportConfigValue<Ctx> = ConfigValue<ReportConfig, Ctx>;

/**
 * Posts progress to the agent's channels.
 */
export interface Reporter {
  /**
   * Posts `message` to the destinations: `options.to`, else the `report`
   * config, else the channel named `main`. With no destination it does
   * nothing. Each post is a step, so a replay never posts twice. While the
   * agent's `scores` are on, the first post is scored `agent.first_output_ms`
   * (the trigger event to the post) and each later one `agent.output_gap_ms`
   * (the previous post to this one), on the post's own step.
   */
  (
    /**
     * The text, or a message with a kind.
     */
    message: string | ChannelMessage,
    options?: {
      /**
       * Overrides the configured destinations for this report.
       */
      to?: ReportConfig;
    },
  ): Promise<void>;

  /**
   * Shows a task card in the progress stream of the destinations that have
   * one (a channel with a `stream`); the others ignore it. The channel's
   * limits are kept for you: when a stream is about to hold more unique cards
   * than the surface allows, or has been open as long as the surface lets it,
   * or the surface says it ended, the reporter starts a new stream whose first
   * card is a `summary` card for the ones left behind, and writes only the
   * card at hand. Cards written together are written one after another, in
   * the order they were called, so parallel tools cannot race a stream. Each
   * write is a step, so a replay writes nothing twice. A card updated after
   * its stream was left is shown again in the stream the reporter is writing
   * to, as the surface cannot change a stream that has ended. A stream is
   * kept per channel object, so a channel passed inline in `to` must be the
   * same object every time, or each call starts a stream of its own.
   */
  card(
    /**
     * The card to add or update.
     */
    card: ChannelCard,
    options?: {
      /**
       * Overrides the configured destinations for this card.
       */
      to?: ReportConfig;
    },
  ): Promise<void>;
}

/**
 * Where a card stream stands, kept in the result of the step that wrote the
 * last card, so a replay has it without writing again.
 */
interface CardStreamState {
  /**
   * The stream being written to.
   */
  stream: string;

  /**
   * When it was started, in milliseconds since the epoch.
   */
  startedAt: number;

  /**
   * The unique cards it holds.
   */
  ids: string[];

  /**
   * The unique cards of every stream before this one, plus this one's.
   */
  total: number;
}

const summaryCardId = "summary";

const checkCard = (card: ChannelCard): void => {
  if (
    typeof card?.id !== "string" ||
    card.id.length < 1 ||
    card.id.length > 100 ||
    card.id === summaryCardId ||
    typeof card.title !== "string"
  ) {
    throw new NonRetriableError(
      `report.card: a card needs a title and an id of 1 to 100 characters other than "${summaryCardId}".`,
    );
  }
};

/**
 * Writes one card to a destination's stream, rolling over to a new stream when
 * its limits say so. Returns where the stream stands.
 */
const writeCard = async (
  stream: ChannelStream,
  card: ChannelCard,
  before: CardStreamState | undefined,
): Promise<CardStreamState> => {
  const { limits } = stream;
  const now = Date.now();
  const known = before?.ids.includes(card.id) === true;
  const full =
    before !== undefined && !known && before.ids.length >= limits.rollAt;
  const old = before !== undefined && now - before.startedAt >= limits.maxAgeMs;

  if (before && !full && !old) {
    try {
      await stream.append(before.stream, [card]);

      return known
        ? before
        : { ...before, ids: [...before.ids, card.id], total: before.total + 1 };
    } catch (error) {
      // Only a stream that has ended is rolled over; any other failure is a
      // failure.
      if (!(error instanceof ChannelStreamEnded)) {
        throw error;
      }
    }
  }

  // A new stream starts with a summary of the cards it leaves, not with their
  // history.
  const started = await stream.start();
  const cards: ChannelCard[] = before
    ? [
        {
          id: summaryCardId,
          title: "Earlier steps",
          status: "done",
          details: `${before.total} steps so far`,
        },
        card,
      ]
    : [card];

  try {
    await stream.append(started, cards);
  } catch (error) {
    // The step is retried from the old state and would start another stream:
    // close this one, which nothing else will know about.
    await stream.stop?.(started).catch(() => {
      return undefined;
    });

    throw error;
  }

  if (before) {
    await stream.stop?.(before.stream).catch(() => {
      return undefined;
    });
  }

  return {
    stream: started,
    startedAt: now,
    ids: before ? [summaryCardId, card.id] : [card.id],
    total: (before?.total ?? 0) + (known ? 0 : 1),
  };
};

/**
 * Makes the `report` function of a run.
 */
export const createReporter = (
  /**
   * The run's channels by name.
   */
  channels: Record<string, Channel>,

  /**
   * The resolved `report` config, if the agent set one.
   */
  configured: ReportConfig | undefined,

  /**
   * Runs a durable step, `step.run`.
   */
  runStep: (
    id: string,
    fn: () => Promise<number | undefined>,
  ) => Promise<unknown>,

  /**
   * Scores the posts when given: `since` is when the run began (ms since the
   * epoch), which the first post is measured from; without it the first post
   * is not scored.
   */
  scores?: { since?: number },
): Reporter => {
  let reports = 0;
  // Whether a post of this run has finished, live or replayed.
  let posted = false;
  // When the last post finished. With scores on, each post step returns it, so
  // a replay has it from the saved result without running the post again. A
  // post saved by a run that had no scores returned nothing and has none.
  let lastPostAt: number | undefined;

  const destinationsOf = (options?: { to?: ReportConfig }) => {
    const wanted = options?.to ?? configured ?? "main";
    const targets = [wanted].flat();

    // Every name is checked before anything is posted, so a wrong name fails
    // the report before it has half happened.
    return targets.flatMap((target, index) => {
      if (typeof target !== "string") {
        return [{ name: `inline${index}`, channel: target, index }];
      }

      const channel = Object.hasOwn(channels, target)
        ? channels[target]
        : undefined;

      // The default destination is optional; a name somebody wrote is not.
      if (!channel && wanted === "main" && !options?.to && !configured) {
        return [];
      }

      if (!channel) {
        throw new NonRetriableError(
          `report: there is no channel named "${target}". The agent's channels are: ${Object.keys(channels).join(", ") || "none"}.`,
        );
      }

      return [{ name: target, channel, index }];
    });
  };

  async function report(
    message: string | ChannelMessage,
    options?: { to?: ReportConfig },
  ) {
    const normalized: ChannelMessage =
      typeof message === "string" ? { text: message } : message;

    const n = ++reports;
    const destinations = destinationsOf(options);

    // Measured from before this report's first post, so a second destination
    // is not scored against its sibling.
    const first = !posted;
    const since = scores ? (first ? scores.since : lastPostAt) : undefined;

    for (const { name, channel, index } of destinations) {
      const postedAt = await runStep(
        `report:${n}:${index}:${name}`,
        async () => {
          await channel.post(normalized);

          // Without scores the step returns what it always did, nothing, so
          // the saved result of a run does not depend on this setting.
          if (!scores) {
            return;
          }

          const now = Date.now();

          if (since !== undefined) {
            scoreThisStep(
              first ? "agent.first_output_ms" : "agent.output_gap_ms",
              Math.max(0, now - since),
            );
          }

          return now;
        },
      );

      posted = true;
      lastPostAt = typeof postedAt === "number" ? postedAt : undefined;
    }
  }

  // Where each destination's card stream stands, and the end of the queue of
  // card writes: they run one at a time, in call order.
  const cardStreams = new Map<Channel, CardStreamState>();
  let queue: Promise<unknown> = Promise.resolve();
  let cards = 0;

  async function card(card: ChannelCard, options?: { to?: ReportConfig }) {
    checkCard(card);

    const n = ++cards;
    const destinations = destinationsOf(options).filter(({ channel }) => {
      return channel.stream !== undefined;
    });

    const write = queue.then(async () => {
      for (const { name, channel, index } of destinations) {
        const stream = channel.stream as ChannelStream;
        const state = (await runStep(
          `report:card:${n}:${index}:${name}`,
          // The step saves where the stream stands, not a time: the runner is
          // typed for the post steps, which save one.
          (async () => {
            return writeCard(stream, card, cardStreams.get(channel));
          }) as unknown as () => Promise<number | undefined>,
        )) as CardStreamState;

        cardStreams.set(channel, state);
      }
    });

    // One failed write must not stop the ones after it from running.
    queue = write.catch(() => {
      return undefined;
    });

    return write;
  }

  return Object.assign(report, { card }) as Reporter;
};

/**
 * Checks `value` against a Standard Schema synchronously, for the small
 * hand-written schemas of the trigger helpers. A value that does not fit is a
 * `NonRetriableError`: retrying cannot change the event.
 */
export const parseWith = <T>(
  /**
   * A schema whose validation is synchronous.
   */
  schema: StandardSchemaV1<unknown, T>,

  /**
   * The value to check.
   */
  value: unknown,

  /**
   * Names the value in the error.
   */
  what: string,
): T => {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error(`${what}: the schema must validate synchronously.`);
  }

  if (result.issues) {
    throw new NonRetriableError(
      `${what}: ${result.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; ")}`,
    );
  }

  return result.value;
};

/**
 * Like `parseWith()`, for a schema that may validate asynchronously.
 */
export const parseWithAsync = async <T>(
  /**
   * The schema.
   */
  schema: StandardSchemaV1<unknown, T>,

  /**
   * The value to check.
   */
  value: unknown,

  /**
   * Names the value in the error.
   */
  what: string,
): Promise<T> => {
  const result = await schema["~standard"].validate(value);

  if (result.issues) {
    throw new NonRetriableError(
      `${what}: ${result.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; ")}`,
    );
  }

  return result.value;
};

/**
 * What a field of `objectSchema` must be.
 *
 * - `"string"` and `"number"`: required.
 * - `"string?"`: a string, or missing.
 * - `"nullable"`: a string, missing or null.
 * - `{ pattern }`: a string the pattern matches; with `optional`, or missing.
 */
export type FieldSpec =
  | "string"
  | "string?"
  | "nullable"
  | "number"
  | { pattern: RegExp; optional?: boolean };

/**
 * A Standard Schema for an object with the listed fields. Other fields pass
 * through.
 */
export const objectSchema = <T>(
  fields: Record<string, FieldSpec>,
): StandardSchemaV1<unknown, T> => {
  return {
    "~standard": {
      version: 1,
      vendor: "inngest",
      validate: (value) => {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected an object" }] };
        }

        const issues: StandardSchemaV1.Issue[] = [];

        for (const [field, spec] of Object.entries(fields)) {
          const found = (value as Record<string, unknown>)[field];

          const optional =
            spec === "string?" ||
            spec === "nullable" ||
            (typeof spec === "object" && spec.optional === true);

          if (found === undefined && optional) {
            continue;
          }

          if (found === null && spec === "nullable") {
            continue;
          }

          const wanted = spec === "number" ? "number" : "string";

          if (typeof found !== wanted) {
            issues.push({
              message: `\`${field}\` must be a ${wanted}`,
              path: [field],
            });

            continue;
          }

          if (typeof spec === "object" && !spec.pattern.test(found as string)) {
            issues.push({
              message: `\`${field}\` is not a valid value`,
              path: [field],
            });
          }
        }

        return issues.length > 0 ? { issues } : { value: value as T };
      },
    },
  };
};

/**
 * What a trigger helper returns: an event that talks to an agent, with the
 * thread key as a CEL expression over `event`. It is the shape the agent
 * config's `on` takes.
 */
export interface ChannelTrigger<TData = unknown> {
  /**
   * The event name.
   */
  event: string;

  /**
   * An expression the event must match, like the `if` of a trigger.
   */
  if?: string;

  /**
   * The thread key, a CEL expression over `event`.
   */
  thread: string;

  /**
   * The text of the message the event carries.
   */
  message: (event: { data: Record<string, unknown> }) => string | undefined;

  /**
   * The shape of the event's `data`.
   */
  schema: StandardSchemaV1<unknown, TData>;
}

/**
 * Throws a `NonRetriableError` unless `value` is in the allow list. The
 * triggers filter on the same list, but an event can reach a channel by
 * another route, so the channel checks it again.
 */
export const assertAllowed = (
  /**
   * What is checked, for the error: `"channel"`, `"repository"`.
   */
  what: string,

  /**
   * The value from the event.
   */
  value: string,

  /**
   * The allowed values.
   */
  allowed: readonly string[],
): void => {
  if (!allowed.includes(value)) {
    throw new NonRetriableError(
      `The ${what} "${value}" is not in the allow list, so nothing is posted there.`,
    );
  }
};

/**
 * Cuts `text` to at most `max` characters, ending in an ellipsis, without
 * splitting a surrogate pair.
 */
export const truncate = (
  /**
   * The text.
   */
  text: string,

  /**
   * The most characters (UTF-16 units) to keep, the ellipsis included.
   */
  max: number,
): string => {
  if (text.length <= max) {
    return text;
  }

  let end = max - 1;
  const last = text.charCodeAt(end - 1);

  // A high surrogate at the cut would leave half of a pair.
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end)}…`;
};

/**
 * The longest an adapter waits for its API.
 */
export const requestTimeoutMs = 10_000;

/**
 * Makes the error for a failed API call: a `NonRetriableError` when trying
 * again cannot help (a client error other than a timeout or a rate limit), a
 * plain `Error` when it can.
 */
export const apiError = (
  /**
   * The message.
   */
  message: string,

  /**
   * Whether a retry could succeed.
   */
  retryable: boolean,
): Error => {
  return retryable ? new Error(message) : new NonRetriableError(message);
};

/**
 * Throws a `NonRetriableError` unless `signal` is safe to put in a button, a
 * block ID or a comment marker.
 */
export const assertSignal = (
  /**
   * The ask's signal.
   */
  signal: string,
): void => {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(signal)) {
    throw new NonRetriableError(
      "An ask signal is 1 to 200 letters, digits, and the characters _ . : -.",
    );
  }
};

/**
 * Whether an HTTP status is worth retrying: a timeout, a rate limit or a
 * server error.
 */
export const retryableStatus = (status: number): boolean => {
  return status === 408 || status === 429 || status >= 500;
};

/**
 * POSTs JSON with a timeout. Returns the status and the parsed body (`{}` when
 * the body is not JSON).
 */
export const postJson = async (
  /**
   * The URL.
   */
  url: string,

  /**
   * The request headers; `content-type` is added.
   */
  headers: Record<string, string>,

  /**
   * The JSON body.
   */
  body: unknown,
): Promise<{
  status: number;
  ok: boolean;
  json: Record<string, unknown>;
  limited: boolean;
}> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),

    // A redirect would turn the POST into a GET and report the post as sent.
    redirect: "manual",
  });

  const parsed: unknown = await res.json().catch(() => {
    return {};
  });

  // A body that is not a JSON object (`null`, a list) is no body.
  const json =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  // GitHub answers a secondary rate limit with 403 and one of these.
  const limited =
    res.headers.get("retry-after") !== null ||
    res.headers.get("x-ratelimit-remaining") === "0";

  return { status: res.status, ok: res.ok, json, limited };
};
