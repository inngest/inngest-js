/**
 * @module
 * The fake Slack. It speaks the subset of the Slack Web API that the SDK's
 * Slack channel uses (`chat.postMessage`, the stream methods, the status
 * calls, `auth.test`) under `/slack/api/<method>`, and the mini UI's own
 * routes under `/api/slack`. A message typed in the UI becomes a
 * `slack/message` event; anything the agent posts is stored and shown, with
 * no event.
 */
import type { Inngest } from "inngest";
import type { Db } from "./db.ts";
import { HttpError, type Router } from "./http.ts";
import {
  botId,
  botUser,
  slackChannels as channelIds,
  humanUser,
} from "./settings.ts";

export const slackChannelList = [
  { id: "C01GENERAL", name: "general", topic: "Company-wide chat" },
  { id: "C02ENG", name: "eng", topic: "Engineering" },
  { id: "C03SUPPORT", name: "support", topic: "Customer questions" },
];

export const slackUsers = [
  { id: humanUser, name: "You", color: "#2eb67d" },
  { id: "U02PRIYA", name: "Priya", color: "#ecb22e" },
  { id: botUser, name: "Tour Bot", color: "#7c5cff", bot: true },
];

interface MessageRow {
  ts: string;
  channel: string;
  thread_ts: string | null;
  user_id: string;
  text: string;
  blocks: string | null;
  plan_title: string | null;
  cards: string | null;
  stream_open: number;
}

interface Card {
  id: string;
  title: string;
  status: string;
  details?: string;
  output?: string;
}

let sequence = 0;

const newTs = () => {
  const now = Date.now();
  const micros = (now % 1000) * 1000 + (sequence++ % 1000);

  return `${Math.floor(now / 1000)}.${String(micros).padStart(6, "0")}`;
};

const statusText: Record<string, string> = {
  processing: "is working...",
  suspended: "is waiting for you...",
  active: "",
};

export interface SlackDeps {
  db: Db;
  router: Router;
  inngest: Inngest;
  changed: () => void;
}

export const setupSlack = (deps: SlackDeps) => {
  const { db, router, inngest, changed } = deps;

  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_messages (
      ts TEXT PRIMARY KEY, channel TEXT NOT NULL, thread_ts TEXT,
      user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', blocks TEXT,
      plan_title TEXT, cards TEXT, stream_open INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS slack_reactions (
      channel TEXT NOT NULL, ts TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (channel, ts, user_id, name)
    );
    CREATE TABLE IF NOT EXISTS slack_status (
      channel TEXT NOT NULL, thread_ts TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (channel, thread_ts)
    );
  `);

  const channelExists = (id: unknown) => {
    return channelIds.includes(String(id));
  };

  const insert = (
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
    extra: Partial<MessageRow> = {},
  ) => {
    const ts = newTs();

    db.run(
      `INSERT INTO slack_messages (ts, channel, thread_ts, user_id, text, blocks, plan_title, cards, stream_open)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ts,
      channel,
      threadTs ?? null,
      user,
      text,
      extra.blocks ?? null,
      extra.plan_title ?? null,
      extra.cards ?? null,
      extra.stream_open ?? 0,
    );
    changed();

    return ts;
  };

  // Applies a stream's `plan_update` and `task_update` chunks.
  const applyChunks = (ts: string, chunks: unknown) => {
    const row = db.get<MessageRow>(
      "SELECT * FROM slack_messages WHERE ts = ?",
      ts,
    );
    const cards = JSON.parse(row?.cards ?? "[]") as Card[];
    let title = row?.plan_title ?? null;

    for (const chunk of (Array.isArray(chunks) ? chunks : []) as Record<
      string,
      unknown
    >[]) {
      if (chunk.type === "plan_update") {
        title = String(chunk.title ?? "");
      }

      if (chunk.type === "task_update") {
        const card = chunk as unknown as Card;
        const at = cards.findIndex((existing) => {
          return existing.id === card.id;
        });

        if (at === -1) {
          cards.push(card);
        } else {
          cards[at] = { ...cards[at], ...card };
        }
      }
    }

    db.run(
      "UPDATE slack_messages SET plan_title = ?, cards = ? WHERE ts = ?",
      title,
      JSON.stringify(cards),
      ts,
    );
  };

  const streamRow = (ts: unknown) => {
    return db.get<MessageRow>(
      "SELECT * FROM slack_messages WHERE ts = ?",
      String(ts),
    );
  };

  const methods: Record<
    string,
    (body: Record<string, unknown>) => Record<string, unknown>
  > = {
    "auth.test": () => {
      return { ok: true, team_id: "T01ACME", user_id: botUser, bot_id: botId };
    },
    "chat.postMessage": (body) => {
      if (!channelExists(body.channel)) {
        return { ok: false, error: "channel_not_found" };
      }

      const ts = insert(
        String(body.channel),
        botUser,
        String(body.text ?? ""),
        body.thread_ts ? String(body.thread_ts) : undefined,
        { blocks: body.blocks ? JSON.stringify(body.blocks) : null },
      );

      return { ok: true, channel: body.channel, ts };
    },
    "chat.startStream": (body) => {
      if (!channelExists(body.channel)) {
        return { ok: false, error: "channel_not_found" };
      }

      const ts = insert(
        String(body.channel),
        botUser,
        "",
        body.thread_ts ? String(body.thread_ts) : undefined,
        { stream_open: 1, cards: "[]" },
      );

      applyChunks(ts, body.chunks);
      changed();

      return { ok: true, channel: body.channel, ts };
    },
    "chat.appendStream": (body) => {
      const row = streamRow(body.ts);

      if (!row) {
        return { ok: false, error: "message_not_found" };
      }

      if (!row.stream_open) {
        return { ok: false, error: "message_not_in_streaming_state" };
      }

      applyChunks(row.ts, body.chunks);
      changed();

      return { ok: true };
    },
    "chat.stopStream": (body) => {
      const row = streamRow(body.ts);

      if (!row) {
        return { ok: false, error: "message_not_found" };
      }

      if (!row.stream_open) {
        return { ok: false, error: "message_not_in_streaming_state" };
      }

      db.run(
        "UPDATE slack_messages SET stream_open = 0, text = ?, blocks = ? WHERE ts = ?",
        String(body.markdown_text ?? ""),
        body.blocks ? JSON.stringify(body.blocks) : null,
        row.ts,
      );
      changed();

      return { ok: true };
    },
  };

  const setStatus = (body: Record<string, unknown>) => {
    const channel = String(body.channel_id);
    const threadTs = String(body.thread_ts);
    const text = statusText[String(body.status)] ?? String(body.status ?? "");

    if (text) {
      db.run(
        "INSERT OR REPLACE INTO slack_status (channel, thread_ts, text) VALUES (?, ?, ?)",
        channel,
        threadTs,
        text,
      );
    } else {
      db.run(
        "DELETE FROM slack_status WHERE channel = ? AND thread_ts = ?",
        channel,
        threadTs,
      );
    }

    changed();

    return { ok: true };
  };

  methods["agents.sessions.setStatus"] = setStatus;
  methods["assistant.threads.setStatus"] = setStatus;

  router.route("POST", "/slack/api/:method", ({ params, body }) => {
    const method = methods[params.method ?? ""];

    return method ? method(body) : { ok: false, error: "unknown_method" };
  });

  router.route("GET", "/api/slack/state", () => {
    return {
      channels: slackChannelList,
      users: slackUsers,
      human: humanUser,
      messages: db
        .all<MessageRow>("SELECT * FROM slack_messages ORDER BY ts")
        .map((row) => {
          return {
            ts: row.ts,
            channel: row.channel,
            threadTs: row.thread_ts,
            user: row.user_id,
            text: row.text,
            blocks: row.blocks ? JSON.parse(row.blocks) : undefined,
            plan: row.cards
              ? {
                  title: row.plan_title,
                  cards: JSON.parse(row.cards),
                  open: row.stream_open === 1,
                }
              : undefined,
          };
        }),
      reactions: db.all<{
        channel: string;
        ts: string;
        user_id: string;
        name: string;
      }>("SELECT * FROM slack_reactions"),
      statuses: db.all<{ channel: string; thread_ts: string; text: string }>(
        "SELECT * FROM slack_status",
      ),
    };
  });

  /**
   * The person types a message. It becomes a `slack/message` event.
   */
  const say = async (channel: string, text: string, threadTs?: string) => {
    if (!channelExists(channel) || !text.trim()) {
      throw new HttpError(400, { message: "channel and text are required" });
    }

    const ts = insert(channel, humanUser, text.trim(), threadTs);

    await inngest.send({
      name: "slack/message",
      data: { channel, ts, threadTs, text: text.trim(), user: humanUser },
    });

    return { ts, threadTs: threadTs ?? ts };
  };

  router.route("POST", "/api/slack/messages", ({ body }) => {
    return say(
      String(body.channel),
      String(body.text ?? ""),
      body.threadTs ? String(body.threadTs) : undefined,
    );
  });

  // A click on a button of a message (an ask): the block ID is the signal the
  // agent waits on. The buttons are replaced by the answer.
  router.route("POST", "/api/slack/actions", async ({ body }) => {
    const ts = String(body.ts);
    const value = String(body.value);
    const message = db.get<MessageRow>(
      "SELECT * FROM slack_messages WHERE ts = ?",
      ts,
    );
    const blocks = message?.blocks
      ? (JSON.parse(message.blocks) as { type: string; block_id?: string }[])
      : [];
    const actions = blocks.find((block) => {
      return block.type === "actions" && block.block_id;
    });

    if (!message || !actions?.block_id) {
      throw new HttpError(404, { message: "no buttons on that message" });
    }

    const answered = blocks.map((block) => {
      return block === actions
        ? {
            type: "context",
            elements: [{ type: "mrkdwn", text: `You chose *${value}*` }],
          }
        : block;
    });

    db.run(
      "UPDATE slack_messages SET blocks = ? WHERE ts = ?",
      JSON.stringify(answered),
      ts,
    );
    changed();

    await inngest.sendSignal({ signal: actions.block_id, data: value });

    return {};
  });

  router.route("POST", "/api/slack/reactions", async ({ body }) => {
    const channel = String(body.channel);
    const ts = String(body.ts);
    const name = String(body.name);
    const message = db.get<MessageRow>(
      "SELECT * FROM slack_messages WHERE ts = ?",
      ts,
    );

    if (!message) {
      throw new HttpError(404, { message: "no such message" });
    }

    db.run(
      "INSERT OR IGNORE INTO slack_reactions (channel, ts, user_id, name) VALUES (?, ?, ?, ?)",
      channel,
      ts,
      humanUser,
      name,
    );
    changed();

    await inngest.send({
      name: "slack/reaction",
      data: {
        channel,
        ts,
        threadTs: message.thread_ts ?? message.ts,
        reaction: name,
        user: humanUser,
      },
    });

    return {};
  });

  return {
    say,
    reset: () => {
      for (const table of [
        "slack_messages",
        "slack_reactions",
        "slack_status",
      ]) {
        db.run(`DELETE FROM ${table}`);
      }

      changed();
    },
  };
};
