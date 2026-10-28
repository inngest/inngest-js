/**
 * @module
 * EXPERIMENTAL: a small Slack-like trigger helper and channel adapter. First
 * party Slack integration is parked; this is the hand-written version it will
 * replace behind the same interface. The event is `slack/message` with the
 * fields below, which your route sends from Slack's events. Anything that can
 * send that event can steer the agent, so the route must verify Slack's
 * signature before it sends one.
 *
 * Text the agent writes is escaped, never parsed: a `<!channel>`, `<@U123>` or
 * `<https://x|label>` in model output reaches Slack as plain text.
 */
import {
  apiError,
  assertAllowed,
  type Channel,
  type ChannelAsk,
  type ChannelMessage,
  type ChannelTrigger,
  defineChannel,
  objectSchema,
  parseWith,
  postJson,
  retryableStatus,
  truncate,
} from "./channels.ts";

/**
 * The `data` of a `slack/message` event.
 */
export interface SlackMessageData {
  /**
   * The channel ID, such as `C0123ABC`.
   */
  channel: string;

  /**
   * The message's own timestamp, such as `1700000000.000100`.
   */
  ts: string;

  /**
   * The thread the message is in. Missing for a message that starts a thread.
   */
  threadTs?: string;
  text: string;
  user?: string | null;

  /**
   * Set on a message a bot posted. `slack.thread` ignores these.
   */
  botId?: string | null;
}

/**
 * The event a Slack message is sent as.
 */
export const slackMessageEvent = "slack/message";

const channelId = /^[CGD][A-Z0-9]+$/;
const timestamp = /^\d+\.\d+$/;

const slackMessageSchema = objectSchema<SlackMessageData>({
  channel: { pattern: channelId },
  ts: { pattern: timestamp },
  threadTs: { pattern: timestamp, optional: true },
  text: "string",
  user: "nullable",
  botId: "nullable",
});

/**
 * Where and as whom a Slack channel posts.
 */
export interface SlackChannelOptions {
  /**
   * The channel IDs the agent may post in. The same list as the trigger's
   * `in`: an event for any other channel is an error.
   */
  in: string[];

  /**
   * Bot token. Default: `SLACK_BOT_TOKEN`, read when a message is posted.
   */
  token?: string;

  /**
   * Slack Web API base URL. Default: `https://slack.com/api`. It receives the
   * token, so it must come from your config, never from an event.
   */
  apiUrl?: string;
}

/**
 * Where a Slack channel posts: a channel and the thread in it.
 */
export interface SlackTarget {
  channel: string;
  threadTs: string;
}

/**
 * The options of `slack.thread`.
 */
export interface SlackThreadOptions {
  /**
   * The channel IDs to listen in. Required: listening everywhere would let any
   * event steer the agent into any channel its token can reach.
   */
  in: string[];

  /**
   * Also start threads from messages bots posted, the agent's own included.
   * Default: bot messages are ignored.
   */
  allowBots?: boolean;
}

/**
 * Slack's own errors that a retry can get past; every other `ok: false` is a
 * mistake in the request or the setup.
 */
const transientErrors = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

/**
 * Escapes what Slack reads as markup, so text is shown as written.
 */
const escapeSlack = (text: string): string => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

/**
 * The text of a message as Slack shows it: escaped, with errors marked.
 */
const render = (message: ChannelMessage): string => {
  const text = escapeSlack(message.text);

  return message.kind === "error" ? `:warning: ${text}` : text;
};

/**
 * Slack allows 25 elements in an actions block, 100 options in a select, 3000
 * characters in a section and 150 in an option value.
 */
const maxButtons = 25;
const maxSelectOptions = 100;
const maxSelectValue = 150;
const maxSectionText = 3000;
const maxLabel = 75;

const call = async (
  options: SlackChannelOptions,
  method: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const token =
    options.token ??
    (typeof process === "undefined" ? undefined : process.env.SLACK_BOT_TOKEN);

  const res = await postJson(
    `${options.apiUrl ?? "https://slack.com/api"}/${method}`,
    token ? { authorization: `Bearer ${token}` } : {},
    // Nothing in the text is parsed: no mentions, no links, no channel names.
    { parse: "none", link_names: false, ...body },
  );

  if (!res.ok) {
    throw apiError(
      `Slack ${method} failed: HTTP ${res.status}`,
      retryableStatus(res.status),
    );
  }

  if (res.json.ok === false) {
    const error = String(res.json.error ?? "unknown_error");

    throw apiError(
      `Slack ${method} failed: ${error}`,
      transientErrors.has(error),
    );
  }
};

/**
 * The blocks of an ask: the question, its options as buttons (as a menu when
 * there are more than Slack allows buttons), and the time left to answer.
 * `approvers` is not enforced here: the route that receives the answer checks
 * who sent it.
 */
const askBlocks = (ask: ChannelAsk) => {
  const options = ask.options ?? [];

  if (options.length > maxSelectOptions) {
    throw apiError(
      `slack ask: ${options.length} options; Slack allows at most ${maxSelectOptions}.`,
      false,
    );
  }

  if (
    options.length > maxButtons &&
    options.some((option) => {
      return option.length > maxSelectValue;
    })
  ) {
    throw apiError(
      `slack ask: with more than ${maxButtons} options an option may be at most ${maxSelectValue} characters.`,
      false,
    );
  }

  const element =
    options.length > maxButtons
      ? [
          {
            type: "static_select",
            action_id: `${ask.signal}:select`,
            placeholder: { type: "plain_text", text: "Choose" },
            options: options.map((option) => {
              return {
                text: { type: "plain_text", text: truncate(option, maxLabel) },
                value: option,
              };
            }),
          },
        ]
      : options.map((option, index) => {
          return {
            type: "button",
            action_id: `${ask.signal}:${index}`,
            text: { type: "plain_text", text: truncate(option, maxLabel) },
            value: option,
          };
        });

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(escapeSlack(ask.question), maxSectionText),
      },
    },
    ...(element.length > 0
      ? [{ type: "actions", block_id: ask.signal, elements: element }]
      : []),
    ...(ask.timeout
      ? [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Answer within ${escapeSlack(ask.timeout)}.`,
              },
            ],
          },
        ]
      : []),
  ];
};

/**
 * EXPERIMENTAL: the Slack trigger helper and channel adapter.
 */
export const slack = {
  /**
   * A trigger for messages in a Slack thread. A message that starts a thread
   * and the replies in it are one agent thread, keyed by channel and thread
   * timestamp. Messages from bots are ignored unless `allowBots` is set.
   */
  thread: (options: SlackThreadOptions): ChannelTrigger<SlackMessageData> => {
    if (!options?.in?.length) {
      throw new Error(
        "slack.thread: `in` lists the channels to listen in and cannot be empty.",
      );
    }

    for (const id of options.in) {
      if (!channelId.test(id)) {
        throw new Error(`slack.thread: "${id}" is not a Slack channel ID.`);
      }
    }

    const channels = options.in
      .map((id) => {
        return `event.data.channel == ${JSON.stringify(id)}`;
      })
      .join(" || ");

    return {
      event: slackMessageEvent,
      if: options.allowBots
        ? `(${channels})`
        : `!has(event.data.botId) && (${channels})`,
      thread:
        '"slack:" + event.data.channel + "/" + (has(event.data.threadTs) ? event.data.threadTs : event.data.ts)',
      message: (event) => {
        return (event.data as unknown as SlackMessageData).text;
      },
      schema: slackMessageSchema,
    };
  },

  /**
   * The channel that posts in the Slack thread a trigger event is in. It
   * throws when the event's channel is not in `options.in`.
   */
  channel: (
    /**
     * The `slack/message` event, or the target itself.
     */
    source: { data: unknown } | SlackTarget,
    options: SlackChannelOptions,
  ): Channel => {
    if (!options?.in?.length) {
      throw new Error(
        "slack.channel: `in` lists the channels it may post in and cannot be empty.",
      );
    }

    const target: SlackTarget = (() => {
      if ("threadTs" in source) {
        return parseWith(
          objectSchema<SlackTarget>({
            channel: { pattern: channelId },
            threadTs: { pattern: timestamp },
          }),
          source,
          "slack.channel: the target is not valid",
        );
      }

      const data = parseWith(
        slackMessageSchema,
        source.data,
        "slack.channel: the event is not a valid slack/message",
      );

      return { channel: data.channel, threadTs: data.threadTs ?? data.ts };
    })();

    assertAllowed("channel", target.channel, options.in);

    return defineChannel({
      post: async (message) => {
        await call(options, "chat.postMessage", {
          channel: target.channel,
          thread_ts: target.threadTs,
          text: truncate(render(message), maxSectionText * 10),
        });
      },
      ask: async (ask) => {
        await call(options, "chat.postMessage", {
          channel: target.channel,
          thread_ts: target.threadTs,
          text: truncate(escapeSlack(ask.question), maxSectionText),
          blocks: askBlocks(ask),
        });
      },
    });
  },
};
