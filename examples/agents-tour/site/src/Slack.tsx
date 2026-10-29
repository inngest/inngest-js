/**
 * @module
 * The Slack panel: a channel, its threads, a message box, the agent's status
 * line, its task cards and the buttons of its questions. It is a view of the
 * fake Slack in the tour server, so what it shows is what the agent did.
 */
import { useEffect, useRef, useState } from "react";
import { Kbd } from "./keyboard.tsx";
import { postJson, useAction, useFake } from "./live.ts";

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
  replies,
  onOpen,
}: {
  message: Message;
  state: State;
  replies: number;
  onOpen?: () => void;
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
        {onOpen && replies > 0 ? (
          <button type="button" className="replies" onClick={onOpen}>
            {replies} {replies === 1 ? "reply" : "replies"}
          </button>
        ) : null}
      </div>
    </div>
  );
};

export const Slack = () => {
  const state = useFake<State>("/api/slack/state", "slack");
  const [channelId, setChannelId] = useState("C02ENG");
  const [picked, setThread] = useState<string>();
  // Until a thread is picked or a new one is started, the latest one is open.
  const [fresh, setFresh] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const lastRoot = [...(state?.messages ?? [])].reverse().find((message) => {
    return message.channel === channelId && !message.threadTs;
  });
  const thread = picked ?? (fresh ? undefined : lastRoot?.ts);
  const latest = useRef({ state, channelId, thread });

  latest.current = { state, channelId, thread };

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  });

  const send = async () => {
    if (!text.trim()) {
      return;
    }

    const body = text.trim();

    setText("");

    const result = await postJson("/api/slack/messages", {
      channel: channelId,
      text: body,
      threadTs: thread,
    });

    setFresh(false);
    setThread(String(result.threadTs ?? thread ?? ""));
  };

  useAction("slackCompose", () => {
    box.current?.focus();
  });
  useAction("slackNew", () => {
    setThread(undefined);
    setFresh(true);
    box.current?.focus();
  });
  const cycleChannel = () => {
    const { state: current, channelId: at } = latest.current;
    const list = current?.channels ?? [];
    const next = list[(list.findIndex((c) => c.id === at) + 1) % list.length];

    if (next) {
      setChannelId(next.id);
      setThread(undefined);
      setFresh(false);
    }
  };
  const react = () => {
    const { state: current, channelId: at, thread: open } = latest.current;
    const visible = (current?.messages ?? []).filter((message) => {
      return (
        message.channel === at &&
        (open
          ? message.threadTs === open || message.ts === open
          : !message.threadTs)
      );
    });
    const last = visible[visible.length - 1];

    if (last) {
      void postJson("/api/slack/reactions", {
        channel: last.channel,
        ts: last.ts,
        name: "eyes",
      });
    }
  };

  useAction("slackChannel", cycleChannel);
  useAction("slackReact", react);

  const answer = (value: "Approve" | "Deny") => {
    const pending = [...(latest.current.state?.messages ?? [])]
      .reverse()
      .find((message) => {
        return buttonsOf(message).length > 0;
      });

    if (pending) {
      setChannelId(pending.channel);
      setThread(pending.threadTs ?? pending.ts);
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

  const channel = state.channels.find((next) => {
    return next.id === channelId;
  });
  const inChannel = state.messages.filter((message) => {
    return message.channel === channelId;
  });
  const roots = inChannel.filter((message) => {
    return !message.threadTs;
  });
  const repliesTo = (ts: string) => {
    return inChannel.filter((message) => {
      return message.threadTs === ts;
    });
  };
  const root = thread
    ? inChannel.find((message) => {
        return message.ts === thread;
      })
    : undefined;
  const shown = root ? [root, ...repliesTo(root.ts)] : roots;
  const status = root
    ? state.statuses.find((next) => {
        return next.channel === channelId && next.thread_ts === root.ts;
      })
    : undefined;

  return (
    <div className="slack">
      <header className="slack-head">
        <button type="button" className="ghost" onClick={cycleChannel}>
          # {channel?.name} <Kbd action="slackChannel" />
        </button>
        <span className="topic">{channel?.topic}</span>
        {root ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setThread(undefined);
              setFresh(true);
              box.current?.focus();
            }}
          >
            New thread <Kbd action="slackNew" />
          </button>
        ) : (
          <span className="topic">Messages start a thread</span>
        )}
        <button
          type="button"
          className="ghost"
          disabled={shown.length === 0}
          onClick={react}
        >
          React 👀 <Kbd action="slackReact" />
        </button>
      </header>
      <div className="messages">
        {shown.length === 0 ? (
          <p className="empty">
            Nothing yet. Write a message below; the agent picks it up.
          </p>
        ) : null}
        {shown.map((message) => {
          return (
            <MessageView
              key={message.ts}
              message={message}
              state={state}
              replies={root ? 0 : repliesTo(message.ts).length}
              onOpen={root ? undefined : () => setThread(message.ts)}
            />
          );
        })}
        {status ? (
          <div className="status-note">
            Tour Bot {status.text}
            <span className="dots" />
          </div>
        ) : null}
        <div ref={end} />
      </div>
      <div className="composer">
        <textarea
          ref={box}
          value={text}
          rows={2}
          aria-label="Message"
          placeholder={
            root ? "Reply in the thread" : `Message #${channel?.name}`
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={!text.trim()}
          onClick={() => void send()}
        >
          Send <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
};
