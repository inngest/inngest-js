/**
 * @module
 * EXPERIMENTAL: channels, the destinations of an agent: a Slack thread, a
 * pull request comment, a ticket. Progress reports and asks both go through a
 * channel. A channel is an adapter written with `defineChannel`; an agent
 * names its channels in config (a value, or a function of the trigger) and
 * the body reports to them with `report()`.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ConfigValue } from "./defs.ts";

/**
 * A message to a channel.
 */
export interface ChannelMessage {
  text: string;

  /**
   * What the message is, so an adapter can render a result differently from a
   * progress line. Default: `"progress"`.
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
  question: string;
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
 * How to talk to one destination.
 */
export interface Channel {
  /**
   * Posts a message. Runs inside a step, so it may be retried: make it safe to
   * repeat or fail loudly.
   * @param message What to post.
   */
  post(message: ChannelMessage): Promise<void>;

  /**
   * Renders a question and returns once it is shown. The answer does not come
   * back from here: it arrives later as the signal `ask.signal`. A channel that
   * can post but not ask leaves this out.
   * @param ask The question.
   */
  ask?(ask: ChannelAsk): Promise<void>;
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
 *
 * @param adapter How to post, and optionally how to render an ask.
 */
export const defineChannel = (adapter: Channel): Channel => {
  if (typeof adapter?.post !== "function") {
    throw new Error("A channel needs a `post` function.");
  }

  if (adapter.ask !== undefined && typeof adapter.ask !== "function") {
    throw new Error("A channel's `ask` must be a function.");
  }

  return adapter;
};

/**
 * Renders an ask through a channel. This is what `thread.ask` calls; a channel
 * without `ask` is an error that says so, never a silent skip. Call it inside
 * a step, so a replay of the run does not render the question twice.
 * @param channel The channel to ask through.
 * @param ask The question.
 */
export const askThrough = async (
  channel: Channel,
  ask: ChannelAsk,
): Promise<void> => {
  if (!channel.ask) {
    throw new Error(
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

export type ReportConfigValue<Ctx> = ConfigValue<ReportConfig, Ctx>;

/**
 * Posts progress to the agent's channels.
 */
export interface Reporter {
  /**
   * Posts `message` to the destinations: `options.to`, else the `report`
   * config, else the channel named `main`. With no destination it does
   * nothing. Each post is a step, so a replay never posts twice.
   * @param message The text, or a message with a kind.
   * @param options.to Overrides the configured destinations for this report.
   */
  (
    message: string | ChannelMessage,
    options?: { to?: ReportConfig },
  ): Promise<void>;
}

/**
 * Makes the `report` function of a run.
 * @param channels The run's channels by name.
 * @param configured The resolved `report` config, if the agent set one.
 * @param runStep Runs a durable step, `step.run`.
 */
export const createReporter = (
  channels: Record<string, Channel>,
  configured: ReportConfig | undefined,
  runStep: (id: string, fn: () => Promise<void>) => Promise<unknown>,
): Reporter => {
  let reports = 0;

  return async function report(message, options) {
    const normalized: ChannelMessage =
      typeof message === "string" ? { text: message } : message;
    const wanted = options?.to ?? configured ?? "main";
    const targets = [wanted].flat();
    const n = ++reports;

    for (const [index, target] of targets.entries()) {
      let name: string;
      let channel: Channel | undefined;

      if (typeof target === "string") {
        name = target;
        channel = channels[target];

        // The default destination is optional; a name somebody wrote is not.
        if (!channel && wanted === "main" && !options?.to && !configured) {
          continue;
        }

        if (!channel) {
          throw new Error(
            `report: there is no channel named "${target}". The agent's channels are: ${Object.keys(channels).join(", ") || "none"}.`,
          );
        }
      } else {
        name = `inline${index}`;
        channel = target;
      }

      const destination = channel;
      await runStep(`report:${n}:${index}:${name}`, async () => {
        await destination.post(normalized);
      });
    }
  };
};

/**
 * Checks `value` against a Standard Schema synchronously, for the small
 * hand-written schemas of the trigger helpers.
 * @param schema A schema whose validation is synchronous.
 * @param value The value to check.
 * @param what Names the value in the error.
 */
export const parseWith = <T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
  what: string,
): T => {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error(`${what}: the schema must validate synchronously.`);
  }

  if (result.issues) {
    throw new Error(
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
 * A Standard Schema for an object whose listed fields are strings (required)
 * or optional strings, or numbers. Other fields pass through.
 * @param fields Field name to `"string"`, `"string?"` or `"number"`.
 */
export const objectSchema = <T>(
  fields: Record<string, "string" | "string?" | "number">,
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

        for (const [field, type] of Object.entries(fields)) {
          const found = (value as Record<string, unknown>)[field];

          if (found === undefined && type === "string?") {
            continue;
          }

          if (typeof found !== (type === "number" ? "number" : "string")) {
            issues.push({
              message: `\`${field}\` must be a ${type === "number" ? "number" : "string"}`,
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
