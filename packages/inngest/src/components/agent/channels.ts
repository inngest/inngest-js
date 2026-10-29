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
export interface ChannelMessage<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * The text to post.
   */
  text: string;

  /**
   * Structured data beside the text, such as the rows of a table or the
   * numbers of a result. The channel gets it with the text and decides how to
   * show it (the Slack and GitHub adapters show only the text), and it is
   * saved in the post step's result, so a trace or dashboard can render it.
   * It must be plain JSON, a plain object of at most 32 KB.
   */
  data?: TData;

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

  /**
   * What the step produced, shown with the card.
   */
  output?: string;

  /**
   * Where the step looked, such as pages it read: shown as links on the card.
   */
  sources?: { url: string; text: string }[];
}

/**
 * Whether the agent is working on a thread, as a surface shows it (Slack's
 * status line under the thread): `"working"` while a turn runs, `"idle"`
 * when it waits for the next message, `"waiting"` when it waits for a person.
 */
export type ChannelStatus = "working" | "idle" | "waiting";

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
   * Runs inside a step. It writes `options.cards` as the stream's first
   * cards, so a stream is never left without them if the first write fails.
   */
  start(
    /**
     * The title, the person the stream is for, and its first cards.
     */
    options: ChannelStreamStart,
  ): Promise<string>;

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
   * Closes a stream, with its final content when it has some. The reporter
   * calls it without `final` for a stream it leaves for a new one, and a
   * failure there is ignored; with `final` (from `report.finish()`) a failure
   * fails the step.
   */
  stop?(
    /**
     * The stream.
     */
    stream: string,

    /**
     * What the stream ends with.
     */
    final?: ChannelStreamFinal,
  ): Promise<void>;

  /**
   * The card that says the stream goes on in another process, after a restart
   * or a deploy. The reporter writes it once, together with the first card
   * after the run's `restarts` grew, and counts it against the stream's
   * limits. Give it an `id` of its own for each `restarts`. Optional: a
   * stream without it says nothing.
   */
  continued?(
    /**
     * How many times the run has continued in another process.
     */
    restarts: number,
  ): ChannelCard;
}

/**
 * What a stream starts with.
 */
export interface ChannelStreamStart {
  /**
   * What the stream is about, such as a plan title of two to four words.
   */
  title?: string;

  /**
   * The person and workspace the stream is for, as the surface needs them
   * (Slack: `recipient_user_id` and `recipient_team_id`).
   */
  recipient?: { user?: string; team?: string };

  /**
   * The first cards. The adapter writes them as part of starting.
   */
  cards?: ChannelCard[];
}

/**
 * What a stream ends with.
 */
export interface ChannelStreamFinal {
  /**
   * Markdown text for the end of the stream.
   */
  text?: string;

  /**
   * Blocks in the surface's own format (Slack: the `blocks` of
   * `chat.stopStream`, such as a context-actions block with feedback
   * buttons). Only the surface they are made for understands them.
   */
  blocks?: unknown[];
}

/**
 * How a report to a stream is written.
 */
export interface ReportStreamOptions {
  /**
   * Overrides the configured destinations.
   */
  to?: ReportConfig;

  /**
   * The base of the step ID, for the caller that wants stable step IDs (a
   * trace that asserts one per label). Default: `report:<kind>:<n>`, with
   * the destination appended. With a base, the destination is appended only
   * when there is more than one.
   */
  stepId?: string;
}

/**
 * How to talk to one destination.
 */
export interface Channel {
  /**
   * Shows whether the agent is working, for `report.status()`. Runs inside a
   * step. Best effort: the reporter ignores a throw, as a status line is never
   * worth failing a run. A channel without one ignores statuses.
   */
  status?(
    /**
     * What to show.
     */
    status: ChannelStatus,
  ): Promise<void>;

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

  if (adapter.status !== undefined && typeof adapter.status !== "function") {
    throw new Error("A channel's `status` must be a function.");
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
 *
 * Every write is a step of its own, so a replay writes nothing twice. Called
 * inside a running `step.run` of your own, a write is made directly instead,
 * on your step: it adds no step and your step's memo covers the replay. A
 * stream's state is then kept in the thread's durable state rather than in
 * step results, so use one form for a stream; a stream written in one form and
 * then in the other starts again.
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
  <TData extends Record<string, unknown> = Record<string, unknown>>(
    /**
     * The text, or a message with a kind and structured `data`.
     */
    message: string | ChannelMessage<TData>,
    options?: {
      /**
       * Overrides the configured destinations for this report.
       */
      to?: ReportConfig;
    },
  ): Promise<void>;

  /**
   * Shows whether the agent is working on the thread, on the destinations
   * whose channel has a `status` (Slack's status line); the others ignore it.
   * Each is a step, so a replay shows nothing twice, and it is written in
   * order with the cards.
   */
  status(
    /**
     * What to show.
     */
    status: ChannelStatus,
    options?: ReportStreamOptions,
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
    options?: ReportStreamOptions,
  ): Promise<void>;

  /**
   * Starts a progress stream with a title, the person it is for and its first
   * cards, on the destinations that have a `stream`; the others ignore it. A
   * stream that is open is left (stopped without final content), and later
   * cards go to the new one, which keeps the title and recipient if it rolls
   * over. Use it when the title or the recipient is known; a first
   * `report.card()` starts a stream without them.
   */
  begin(
    /**
     * The title, recipient and first cards of the stream.
     */
    start: ChannelStreamStart,
    options?: ReportStreamOptions,
  ): Promise<void>;

  /**
   * Ends the open progress stream with final content: markdown text and
   * surface-specific blocks (Slack: the blocks of `chat.stopStream`, such as
   * feedback buttons). A destination with no open stream posts `final.text`
   * as a message, if there is any. The next card starts a new stream.
   */
  finish(
    /**
     * What the stream ends with.
     */
    final?: ChannelStreamFinal,
    options?: ReportStreamOptions,
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

  /**
   * What the stream was started with, so one that rolls over keeps it.
   */
  title?: string;
  recipient?: { user?: string; team?: string };

  /**
   * The run's `restarts` when the stream last said it was continued.
   */
  restarts: number;
}

const summaryCardId = "summary";

const maxDataBytes = 32 * 1024;

/**
 * Throws a `NonRetriableError` unless `data` is nothing or a plain JSON object
 * small enough to save in a step result.
 */
const checkData = (data: unknown): void => {
  if (data === undefined) {
    return;
  }

  let size = Number.POSITIVE_INFINITY;

  try {
    const json = JSON.stringify(data);

    size =
      json === undefined
        ? Number.POSITIVE_INFINITY
        : new TextEncoder().encode(json).length;
  } catch {
    // Not serializable: refused below.
  }

  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    (Object.getPrototypeOf(data) !== Object.prototype &&
      Object.getPrototypeOf(data) !== null) ||
    size > maxDataBytes
  ) {
    throw new NonRetriableError(
      "report: `data` must be a plain JSON object of at most 32 KB.",
    );
  }
};

const cardStatuses = ["pending", "running", "done", "error"];

const channelStatuses = ["working", "idle", "waiting"];

const maxSources = 20;

const checkCard = (card: ChannelCard): void => {
  if (
    typeof card?.id !== "string" ||
    card.id.length < 1 ||
    card.id.length > 100 ||
    card.id === summaryCardId ||
    typeof card.title !== "string" ||
    card.title.length < 1 ||
    (card.status !== undefined && !cardStatuses.includes(card.status)) ||
    (card.details !== undefined && typeof card.details !== "string") ||
    (card.output !== undefined && typeof card.output !== "string") ||
    (card.sources !== undefined &&
      (!Array.isArray(card.sources) ||
        card.sources.length > maxSources ||
        card.sources.some((source) => {
          return (
            typeof source?.url !== "string" ||
            source.url.length < 1 ||
            typeof source.text !== "string" ||
            source.text.length < 1
          );
        })))
  ) {
    throw new NonRetriableError(
      `report.card: a card needs a title, an id of 1 to 100 characters other than "${summaryCardId}", and a status of ${cardStatuses.join(", ")} if it has one; details and output are text, and sources are up to ${maxSources} of { url, text }.`,
    );
  }
};

const noop = () => {
  return undefined;
};

/**
 * Starts a stream with `cards` and leaves `before`, if there is one.
 */
const startFresh = async (
  stream: ChannelStream,
  before: CardStreamState | undefined,
  start: Omit<ChannelStreamStart, "cards">,
  cards: ChannelCard[],
  total: number,
  restarts: number,
): Promise<CardStreamState> => {
  const now = Date.now();
  const started = await stream.start({ ...start, cards });

  if (before) {
    await stream.stop?.(before.stream).catch(noop);
  }

  return {
    stream: started,
    startedAt: now,
    ids: cards.map((card) => {
      return card.id;
    }),
    total,
    restarts,
    ...(start.title === undefined ? {} : { title: start.title }),
    ...(start.recipient === undefined ? {} : { recipient: start.recipient }),
  };
};

/**
 * Writes one card to a destination's stream, rolling over to a new stream when
 * its limits say so. Returns where the stream stands.
 */
const writeCard = async (
  stream: ChannelStream,
  card: ChannelCard,
  before: CardStreamState | undefined,
  restarts: number,
): Promise<CardStreamState> => {
  const { limits } = stream;
  const known = before?.ids.includes(card.id) === true;

  // A stream that goes on after a restart says so once, in a card of its own.
  const resumed =
    before && restarts > before.restarts
      ? stream.continued?.(restarts)
      : undefined;
  const added =
    (resumed && !before?.ids.includes(resumed.id) ? 1 : 0) + (known ? 0 : 1);
  const full =
    before !== undefined && before.ids.length + added > limits.rollAt;
  const old =
    before !== undefined && Date.now() - before.startedAt >= limits.maxAgeMs;

  if (before && !full && !old) {
    try {
      const cards = resumed ? [resumed, card] : [card];

      await stream.append(before.stream, cards);

      return {
        ...before,
        restarts: Math.max(before.restarts, restarts),
        ids: [
          ...before.ids,
          ...cards
            .map((written) => {
              return written.id;
            })
            .filter((id) => {
              return !before.ids.includes(id);
            }),
        ],
        total: before.total + (known ? 0 : 1),
      };
    } catch (error) {
      // Only a stream that has ended is rolled over; any other failure is a
      // failure.
      if (!(error instanceof ChannelStreamEnded)) {
        throw error;
      }
    }
  }

  // A new stream starts with a summary of the cards it leaves, not with their
  // history, and keeps the title and recipient the last one had.
  return startFresh(
    stream,
    before,
    { title: before?.title, recipient: before?.recipient },
    before
      ? [
          {
            id: summaryCardId,
            title: "Earlier steps",
            status: "done",
            details: `${before.total} steps so far`,
          },
          card,
        ]
      : [card],
    (before?.total ?? 0) + (known ? 0 : 1),
    restarts,
  );
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

  /**
   * What the run knows that a stream can say: `restarts`, how many times the
   * run continued in another process so far.
   */
  hooks?: {
    restarts?: () => number;

    /**
     * Whether the caller is inside a running step. A report made there is
     * written directly, on that step, instead of in a step of its own: the
     * caller's step memoizes it. A stream's state then lives in `state`
     * (durable, outside the steps), because the step results that carry it
     * in the other form do not exist.
     */
    inStep?: () => boolean;

    /**
     * Where a stream's state is kept between reports made inside steps,
     * by destination.
     */
    state?: {
      get(key: string): Promise<CardStreamState | null | undefined>;
      set(key: string, value: CardStreamState | null): Promise<void>;
    };
  },
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

    checkData(normalized.data);

    const n = ++reports;
    const destinations = destinationsOf(options);

    // Measured from before this report's first post, so a second destination
    // is not scored against its sibling.
    const first = !posted;
    const since = scores ? (first ? scores.since : lastPostAt) : undefined;

    for (const { name, channel, index } of destinations) {
      const postedAt = await runStep(
        `report:${n}:${index}:${name}`,
        (async () => {
          await channel.post(normalized);

          // Without scores or data the step returns what it always did,
          // nothing, so the saved result of a run does not depend on these.
          const now = scores ? Date.now() : undefined;

          if (now !== undefined && since !== undefined) {
            scoreThisStep(
              first ? "agent.first_output_ms" : "agent.output_gap_ms",
              Math.max(0, now - since),
            );
          }

          // The data rides in the result, where a trace or dashboard reads it.
          return normalized.data === undefined
            ? now
            : {
                ...(now === undefined ? {} : { at: now }),
                data: normalized.data,
              };
        }) as unknown as () => Promise<number | undefined>,
      );

      posted = true;
      lastPostAt =
        typeof postedAt === "number"
          ? postedAt
          : (postedAt as { at?: number } | null | undefined)?.at;
    }
  }
  // Where each destination's card stream stands, and the end of the queue of
  // stream writes: they run one at a time, in call order.
  const cardStreams = new Map<Channel, CardStreamState | null>();
  let queue: Promise<unknown> = Promise.resolve();
  const counts = { card: 0, status: 0, begin: 0, finish: 0 };

  /**
   * One write to the destinations' streams, queued after the ones before it.
   * Each destination's step saves where its stream stands (or `null` once it
   * is finished), which is all a replay needs.
   */
  const queued = (
    kind: keyof typeof counts,
    options: ReportStreamOptions | undefined,
    wants: (channel: Channel) => boolean,
    write: (
      channel: Channel,
      before: CardStreamState | undefined,
      restarts: number,
    ) => Promise<CardStreamState | null | undefined>,
  ): Promise<void> => {
    const n = ++counts[kind];
    const direct = hooks?.inStep?.() === true;
    const destinations = destinationsOf(options).filter(({ channel }) => {
      return wants(channel);
    });

    const run = queue.then(async () => {
      for (const { name, channel, index } of destinations) {
        if (direct) {
          // On the caller's step: no step of ours. A stream's state is read
          // from and written to the durable state, which is current when this
          // runs live; a replay skips the caller's step and this with it.
          const key = `__stream:${name}`;
          const keeps = kind !== "status";
          const held = keeps ? await hooks?.state?.get(key) : undefined;
          // The durable state wins; a finished stream is `null` there.
          const before =
            (held === undefined ? cardStreams.get(channel) : held) ?? undefined;
          const state =
            (await write(channel, before, hooks?.restarts?.() ?? 0)) ?? null;

          if (keeps) {
            cardStreams.set(channel, state);
            await hooks?.state?.set(key, state);
          }

          continue;
        }

        const base = options?.stepId;
        const id = base
          ? destinations.length > 1
            ? `${base}:${name}`
            : base
          : `report:${kind}:${n}:${index}:${name}`;
        const restarts = hooks?.restarts?.() ?? 0;
        const before = cardStreams.get(channel) ?? undefined;
        const state = await runStep(
          id,
          // The step saves where the stream stands, not a time: the runner is
          // typed for the post steps, which save one.
          (async () => {
            return (await write(channel, before, restarts)) ?? null;
          }) as unknown as () => Promise<number | undefined>,
        );

        if (kind === "card" || kind === "begin" || kind === "finish") {
          cardStreams.set(channel, (state as CardStreamState | null) ?? null);
        }
      }
    });

    // One failed write must not stop the ones after it from running.
    queue = run.catch(noop);

    return run;
  };

  async function status(status: ChannelStatus, options?: ReportStreamOptions) {
    if (!channelStatuses.includes(status)) {
      throw new NonRetriableError(
        `report.status: the status is one of ${channelStatuses.join(", ")}.`,
      );
    }

    await queued(
      "status",
      options,
      (channel) => {
        return channel.status !== undefined;
      },
      async (channel) => {
        // A status line is never worth failing a run.
        try {
          await channel.status?.(status);
        } catch {
          // Best effort, as the channel's `status` documents.
        }

        return undefined;
      },
    );
  }

  async function card(card: ChannelCard, options?: ReportStreamOptions) {
    checkCard(card);

    await queued(
      "card",
      options,
      (channel) => {
        return channel.stream !== undefined;
      },
      async (channel, before, restarts) => {
        return writeCard(
          channel.stream as ChannelStream,
          card,
          before,
          restarts,
        );
      },
    );
  }

  async function begin(
    start: ChannelStreamStart,
    options?: ReportStreamOptions,
  ) {
    for (const card of start.cards ?? []) {
      checkCard(card);
    }

    await queued(
      "begin",
      options,
      (channel) => {
        return channel.stream !== undefined;
      },
      async (channel, before, restarts) => {
        const cards = start.cards ?? [];

        return startFresh(
          channel.stream as ChannelStream,
          before,
          { title: start.title, recipient: start.recipient },
          cards,
          cards.length,
          restarts,
        );
      },
    );
  }

  async function finish(
    final?: ChannelStreamFinal,
    options?: ReportStreamOptions,
  ) {
    await queued(
      "finish",
      options,
      (channel) => {
        return channel.stream !== undefined || final?.text !== undefined;
      },
      async (channel, before) => {
        const stop = before ? channel.stream?.stop : undefined;

        if (before && stop) {
          await stop.call(channel.stream, before.stream, final);
        } else if (final?.text !== undefined) {
          // No open stream, or one that cannot be stopped with content: the
          // text still reaches the thread.
          await channel.post({ text: final.text });
        }

        return null;
      },
    );
  }

  return Object.assign(report, { card, status, begin, finish }) as Reporter;
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
