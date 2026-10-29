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
  assertSignal,
  type Channel,
  type ChannelAsk,
  type ChannelCard,
  type ChannelMessage,
  ChannelStreamEnded,
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

  /**
   * The message's text.
   */
  text: string;

  /**
   * The author's Slack user ID. Missing or `null` for a bot message.
   */
  user?: string | null;

  /**
   * Set on a message a bot posted. `slack.thread` ignores these.
   */
  botId?: string;
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
  botId: "string?",
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

  /**
   * The user a streamed progress message is for (`recipient_user_id`, which
   * Slack requires to start a stream in a channel). Default: the author of
   * the `slack/message` event the channel was made from.
   */
  user?: string;

  /**
   * The workspace of a streamed message (`recipient_team_id`). Default: the
   * workspace of the token, found with `auth.test` when the stream starts.
   */
  team?: string;

  /**
   * The title of the plan a stream shows above its task cards. Default:
   * `"Progress"`.
   */
  streamTitle?: string;
}

/**
 * Where a Slack channel posts: a channel and the thread in it.
 */
export interface SlackTarget {
  /**
   * The Slack channel ID.
   */
  channel: string;

  /**
   * The `ts` of the thread's first message.
   */
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
const maxButtonValue = 2000;
const maxSectionText = 3000;
const maxLabel = 75;
const maxCardText = 250;

/**
 * What Slack allows a streamed message to hold, and when it ends one: 50
 * unique task cards, and a stream closes on its own after about ten minutes.
 * The reporter rolls over at 40 cards and at nine minutes.
 */
const streamLimits = { maxCards: 50, rollAt: 40, maxAgeMs: 9 * 60_000 };

const slackCardStatus = {
  pending: "pending",
  running: "in_progress",
  done: "complete",
  error: "error",
} as const;

/**
 * The warning that says Slack dropped part of a streamed update, if any. Slack
 * answers `ok` and says so only in `warning` and `response_metadata`, where
 * it also puts harmless notices such as `missing_charset`, so only the
 * notice about the task limit counts.
 */
const droppedUpdate = (json: Record<string, unknown>): string | undefined => {
  const meta = json.response_metadata as
    | { warnings?: unknown; messages?: unknown }
    | undefined;
  const lines = [
    json.warning,
    ...(Array.isArray(meta?.warnings) ? meta.warnings : []),
    ...(Array.isArray(meta?.messages) ? meta.messages : []),
  ].map(String);

  return lines.find((line) => {
    return /maximum unique tasks/i.test(line);
  });
};

/**
 * Slack's errors for a streamed message that is gone or over.
 */
const streamGone = new Set([
  "message_not_in_streaming_state",
  "message_not_found",
  "cant_update_message",
]);

const streaming = /^chat\.(start|append|stop)Stream$/;

const call = async (
  options: SlackChannelOptions,
  method: string,
  body: Record<string, unknown>,
  /**
   * For a streamed update: Slack answers `ok` and adds a warning when it
   * dropped part of the update, and that warning (the task limit) is an error.
   */
  strict = false,
): Promise<Record<string, unknown>> => {
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

  // A 200 that is not Slack's `{ ok: true }` (an empty or cut-off body) is
  // not a post that landed.
  if (res.json.ok !== true) {
    const error = String(res.json.error ?? "unreadable_response");

    // The stream is over: the reporter starts another.
    if (streaming.test(method) && streamGone.has(error)) {
      throw new ChannelStreamEnded(`Slack ${method}: ${error}`);
    }

    throw apiError(
      `Slack ${method} failed: ${error}`,
      error === "unreadable_response" || transientErrors.has(error),
    );
  }

  const dropped = strict ? droppedUpdate(res.json) : undefined;

  if (dropped) {
    throw apiError(
      `Slack ${method} dropped part of the update: ${dropped}`,
      false,
    );
  }

  return res.json;
};

/**
 * A card as a Slack `task_update` chunk. Text is escaped like any text the
 * agent writes.
 */
/**
 * Card text as Slack shows it: escaped, then cut to Slack's limit without
 * leaving half an entity at the end.
 */
const cardText = (text: string): string => {
  const escaped = escapeSlack(text);

  if (escaped.length <= maxCardText) {
    return escaped;
  }

  return `${escaped.slice(0, maxCardText - 1).replace(/&[a-z]*;?$/, "")}…`;
};

const slackCard = (card: ChannelCard) => {
  return {
    type: "task_update",
    id: card.id,
    title: cardText(card.title),
    status: slackCardStatus[card.status ?? "running"],
    ...(card.details === undefined ? {} : { details: cardText(card.details) }),
  };
};

/**
 * The blocks of an ask: the question, its options as buttons (as a menu when
 * there are more than Slack allows buttons), and the time left to answer.
 * `approvers` is not enforced here: the route that receives the answer checks
 * who sent it.
 */
const askBlocks = (ask: ChannelAsk) => {
  assertSignal(ask.signal);

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

  if (
    options.some((option) => {
      return option.length > maxButtonValue;
    })
  ) {
    throw apiError(
      `slack ask: an option may be at most ${maxButtonValue} characters.`,
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

    // The author of the event the channel is made from: the user a stream is
    // for, unless the options name one.
    const eventUser =
      "threadTs" in source
        ? undefined
        : ((source.data as { user?: string | null }).user ?? undefined);

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
      stream: {
        limits: streamLimits,
        start: async () => {
          const user = options.user ?? eventUser;

          if (!user) {
            throw apiError(
              "slack stream: Slack needs the user a stream is for; pass `user` in the channel options or make the channel from a slack/message event",
              false,
            );
          }

          const team =
            options.team ??
            String((await call(options, "auth.test", {})).team_id ?? "");
          const started = await call(
            options,
            "chat.startStream",
            {
              channel: target.channel,
              thread_ts: target.threadTs,
              recipient_user_id: user,
              recipient_team_id: team,
              task_display_mode: "plan",
              chunks: [
                {
                  type: "plan_update",
                  title: truncate(
                    escapeSlack(options.streamTitle ?? "Progress"),
                    maxCardText,
                  ),
                },
              ],
            },
            true,
          );

          if (typeof started.ts !== "string") {
            throw apiError("Slack chat.startStream returned no ts", false);
          }

          return started.ts;
        },
        append: async (stream, cards) => {
          await call(
            options,
            "chat.appendStream",
            {
              channel: target.channel,
              ts: stream,
              chunks: cards.map((card) => {
                return slackCard(card);
              }),
            },
            true,
          );
        },
        stop: async (stream) => {
          await call(options, "chat.stopStream", {
            channel: target.channel,
            ts: stream,
          });
        },
      },
    });
  },
};
