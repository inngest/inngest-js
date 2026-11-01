/**
 * @module
 * The Slack panel: a channel, its threads, a message box, the agent's status
 * line, its task cards and the buttons of its questions. It is a view of the
 * fake Slack in the tour server, so what it shows is what the agent did.
 */
import { useEffect, useRef } from "react";
import { Kbd } from "./keyboard.tsx";
import { postJson, useAction, useFake } from "./live.ts";
import { messages, pick, replies } from "./random.ts";

interface Card {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  details?: string;
  output?: string;
}

interface Message {
  ts: string;
  channel: string;
  threadTs: string | null;
  user: string;
  text: string;
  blocks?: Block[];
  plan?: { title: string | null; cards: Card[]; open: boolean };
}

interface Block {
  type: string;
  block_id?: string;
  elements?: {
    type: string;
    text?: string | { text: string };
    value?: string;
  }[];
}

interface State {
  channels: { id: string; name: string; topic: string }[];
  users: { id: string; name: string; color: string; bot?: boolean }[];
  messages: Message[];
  reactions: { channel: string; ts: string; user_id: string; name: string }[];
  statuses: { channel: string; thread_ts: string; text: string }[];
}

const decode = (text: string) => {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

// `code` and *bold*, which is all the agents write.
const Text = ({ text }: { text: string }) => {
  let offset = 0;
  const parts = decode(text)
    .split(/(`[^`]+`|\*[^*\n]+\*)/g)
    .map((part) => {
      const at = offset;

      offset += part.length;

      return { at, part };
    });

  return (
    <span className="mtext">
      {parts.map(({ at, part }) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          return <code key={at}>{part.slice(1, -1)}</code>;
        }

        if (part.startsWith("*") && part.endsWith("*") && part.length > 1) {
          return <strong key={at}>{part.slice(1, -1)}</strong>;
        }

        return part;
      })}
    </span>
  );
};

const cardIcon: Record<Card["status"], string> = {
  pending: "○",
  in_progress: "◌",
  complete: "✓",
  error: "!",
};

const buttonsOf = (message: Message) => {
  return (message.blocks ?? [])
    .filter((block) => {
      return block.type === "actions";
    })
    .flatMap((block) => {
      return block.elements ?? [];
    })
    .filter((element) => {
      return element.type === "button";
    });
};

const answerOf = (message: Message) => {
  return (message.blocks ?? [])
    .filter((block) => {
      return block.type === "context";
    })
    .flatMap((block) => {
      return block.elements ?? [];
    })
    .map((element) => {
      return typeof element.text === "string" ? element.text : "";
    })
    .join(" ")
    .replaceAll("*", "");
};

const click = (message: Message, value: string) => {
  return postJson("/api/slack/actions", { ts: message.ts, value });
};

const MessageView = ({
  message,
  state,
}: {
  message: Message;
  state: State;
}) => {
  const author = state.users.find((next) => {
    return next.id === message.user;
  });
  const names = [
    ...new Set(
      state.reactions
        .filter((reaction) => {
          return (
            reaction.channel === message.channel && reaction.ts === message.ts
          );
        })
        .map((reaction) => {
          return reaction.name;
        }),
    ),
  ];
  const buttons = buttonsOf(message);
  const answer = answerOf(message);

  return (
    <div className="smsg">
      <div className="avatar" style={{ background: author?.color }}>
        {(author?.name ?? "?").slice(0, 1)}
      </div>
      <div className="mbody">
        <div className="mhead">
          <strong>{author?.name ?? message.user}</strong>
          {author?.bot ? <span className="app">APP</span> : null}
        </div>
        {message.text ? <Text text={message.text} /> : null}
        {message.plan ? (
          <div className="plan">
            <div className="plantitle">
              {message.plan.title || "Progress"}
              {message.plan.open ? <span className="dots" /> : null}
            </div>
            {message.plan.cards.map((card) => {
              return (
                <div key={card.id} className={`card ${card.status}`}>
                  <span className="cardicon">{cardIcon[card.status]}</span>
                  <div>
                    <div className="cardtitle">{card.title}</div>
                    {card.details ? (
                      <div className="carddetails">{decode(card.details)}</div>
                    ) : null}
                    {card.output ? (
                      <div className="cardoutput">{decode(card.output)}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {buttons.length > 0 ? (
          <div className="asks">
            {buttons.map((button) => {
              const value = button.value ?? "";

              return (
                <button
                  key={value}
                  type="button"
                  className="ask"
                  onClick={() => {
                    void click(message, value);
                  }}
                >
                  {typeof button.text === "object" ? button.text.text : value}{" "}
                  {value === "Approve" ? <Kbd action="approve" /> : null}
                  {value === "Deny" ? <Kbd action="deny" /> : null}
                </button>
              );
            })}
          </div>
        ) : answer ? (
          <div className="asked">{answer}</div>
        ) : null}
        {names.length > 0 ? (
          <div className="reactions">
            {names.map((name) => {
              return (
                <span key={name} className="pill">
                  {name === "eyes" ? "👀" : `:${name}:`}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const channelId = "C02ENG";

export const Slack = () => {
  const state = useFake<State>("/api/slack/state", "slack");
  const end = useRef<HTMLDivElement>(null);
  const latest = useRef(state);

  latest.current = state;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  });

  const post = (text: string, threadTs?: string) => {
    return postJson("/api/slack/messages", {
      channel: channelId,
      text,
      threadTs,
    });
  };
  const lastRoot = () => {
    return [...(latest.current?.messages ?? [])].reverse().find((message) => {
      return message.channel === channelId && !message.threadTs;
    });
  };

  useAction("slackCompose", () => {
    void post(pick(messages));
  });
  useAction("slackNew", () => {
    const root = lastRoot();

    if (root) {
      void post(pick(replies), root.ts);
    }
  });

  const answer = (value: "Approve" | "Deny") => {
    const pending = [...(latest.current?.messages ?? [])]
      .reverse()
      .find((message) => {
        return buttonsOf(message).length > 0;
      });

    if (pending) {
      void click(pending, value);
    }
  };

  useAction("approve", () => {
    answer("Approve");
  });
  useAction("deny", () => {
    answer("Deny");
  });

  if (!state) {
    return <p className="empty">Loading...</p>;
  }

  const inChannel = state.messages.filter((message) => {
    return message.channel === channelId;
  });
  const roots = inChannel.filter((message) => {
    return !message.threadTs;
  });
  const shown = roots.flatMap((root) => {
    return [
      root,
      ...inChannel.filter((message) => {
        return message.threadTs === root.ts;
      }),
    ];
  });

  return (
    <div className="slack">
      <header className="slack-head">
        <span className="topic"># eng</span>
        <button
          type="button"
          onClick={() => {
            void post(pick(messages));
          }}
        >
          Mention the bot <Kbd action="slackCompose" />
        </button>
        <button
          type="button"
          disabled={roots.length === 0}
          onClick={() => {
            const root = lastRoot();

            if (root) {
              void post(pick(replies), root.ts);
            }
          }}
        >
          Reply in thread <Kbd action="slackNew" />
        </button>
      </header>
      <div className="messages">
        {shown.length === 0 ? (
          <p className="empty">Nothing yet. Press Mention the bot.</p>
        ) : null}
        {shown.map((message) => {
          return (
            <div
              key={message.ts}
              className={message.threadTs ? "indent" : undefined}
            >
              <MessageView message={message} state={state} />
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </div>
  );
};
