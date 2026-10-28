/**
 * @module
 * EXPERIMENTAL: a small Slack-like trigger helper and channel adapter. First
 * party Slack integration is parked; this is the hand-written version it will
 * replace behind the same interface. The event is `slack/message` with the
 * fields below, which your route sends from Slack's events.
 */
import {
  type Channel,
  type ChannelAsk,
  type ChannelTrigger,
  defineChannel,
  objectSchema,
  parseWith,
} from "./channels.ts";

/**
 * The `data` of a `slack/message` event.
 */
export interface SlackMessageData {
  channel: string;

  /**
   * The message's own timestamp.
   */
  ts: string;

  /**
   * The thread the message is in. Missing for a message that starts a thread.
   */
  thread_ts?: string;
  text: string;
  user?: string;
}

/**
 * The event a Slack message is sent as.
 */
export const slackMessageEvent = "slack/message";

const slackMessageSchema = objectSchema<SlackMessageData>({
  channel: "string",
  ts: "string",
  thread_ts: "string?",
  text: "string",
  user: "nullable",
});

/**
 * Where and as whom a Slack channel posts.
 */
export interface SlackChannelOptions {
  /**
   * Bot token. Default: `SLACK_BOT_TOKEN`, read when a message is posted.
   */
  token?: string;

  /**
   * Slack Web API base URL. Default: `https://slack.com/api`.
   */
  apiUrl?: string;
}

/**
 * Where a Slack channel posts: a channel and the thread in it.
 */
export interface SlackTarget {
  channel: string;
  thread_ts: string;
}

const call = async (
  options: SlackChannelOptions,
  method: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const token =
    options.token ??
    (typeof process === "undefined" ? undefined : process.env.SLACK_BOT_TOKEN);

  const res = await fetch(
    `${options.apiUrl ?? "https://slack.com/api"}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );

  const json = (await res.json().catch(() => {
    return {};
  })) as { ok?: boolean; error?: string };

  if (!res.ok || json.ok === false) {
    throw new Error(
      `Slack ${method} failed: ${json.error ?? `HTTP ${res.status}`}`,
    );
  }
};

/**
 * Slack allows 25 elements in an actions block and 100 options in a select.
 */
const maxButtons = 25;
const maxSelectOptions = 100;

/**
 * The blocks of an ask: the question, its options as buttons (as a menu when
 * there are more than Slack allows buttons), and the time left to answer.
 * `approvers` is not enforced here: the route that receives the answer checks
 * who sent it.
 * @param ask The question.
 */
const askBlocks = (ask: ChannelAsk) => {
  const options = ask.options ?? [];

  if (options.length > maxSelectOptions) {
    throw new Error(
      `slack ask: ${options.length} options; Slack allows at most ${maxSelectOptions}.`,
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
                text: { type: "plain_text", text: option.slice(0, 75) },
                value: option,
              };
            }),
          },
        ]
      : options.map((option, index) => {
          return {
            type: "button",
            action_id: `${ask.signal}:${index}`,
            text: { type: "plain_text", text: option.slice(0, 75) },
            value: option,
          };
        });

  return [
    { type: "section", text: { type: "mrkdwn", text: ask.question } },
    ...(element.length > 0
      ? [{ type: "actions", block_id: ask.signal, elements: element }]
      : []),
    ...(ask.timeout
      ? [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Answer within ${ask.timeout}.` },
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
   * timestamp.
   * @param options.in Channel IDs to listen in. Default: every channel.
   */
  thread: (
    options: { in?: string[] } = {},
  ): ChannelTrigger<SlackMessageData> => {
    const channels = options.in?.map((id) => {
      return `event.data.channel == ${JSON.stringify(id)}`;
    });

    return {
      event: slackMessageEvent,
      ...(channels?.length ? { if: `(${channels.join(" || ")})` } : {}),
      thread:
        '"slack:" + event.data.channel + "/" + (has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts)',
      message: (event) => {
        return (event.data as unknown as SlackMessageData).text;
      },
      schema: slackMessageSchema,
    };
  },

  /**
   * The channel that posts in the Slack thread a trigger event is in.
   * @param source The `slack/message` event, or the target itself.
   * @param options Token and API URL.
   */
  channel: (
    source: { data: unknown } | SlackTarget,
    options: SlackChannelOptions = {},
  ): Channel => {
    const target: SlackTarget = (() => {
      if ("thread_ts" in source && typeof source.thread_ts === "string") {
        return source;
      }

      const data = parseWith(
        slackMessageSchema,
        (source as { data: unknown }).data,
        "slack.channel: the event is not a slack/message",
      );

      return { channel: data.channel, thread_ts: data.thread_ts ?? data.ts };
    })();

    return defineChannel({
      post: async (message) => {
        await call(options, "chat.postMessage", {
          channel: target.channel,
          thread_ts: target.thread_ts,
          text: message.text,
        });
      },
      ask: async (ask) => {
        await call(options, "chat.postMessage", {
          channel: target.channel,
          thread_ts: target.thread_ts,
          text: ask.question,
          blocks: askBlocks(ask),
        });
      },
    });
  },
};
