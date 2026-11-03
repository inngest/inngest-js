/**
 * @module
 * The Messages tab of the play pane. A text box holds a message the reader can
 * read and edit before sending it as an event, and the tab shows each message
 * as the event it became.
 */
import { useRef, useState } from "react";
import { eventOfMessage } from "../../../shared/events.ts";
import { api } from "../api.ts";
import { Kbd } from "../keyboard.tsx";
import { useAction } from "../live.ts";
import { messages, pick } from "../random.ts";

export const MessagePanel = ({
  target,
  disabled,
}: {
  target: { agent: string; thread: string; threads?: string[] };
  disabled: boolean;
}) => {
  const [sent, setSent] = useState<string[]>([]);
  const [draft, setDraft] = useState(() => pick(messages));
  const field = useRef<HTMLInputElement>(null);
  const threads = target.threads ?? [];

  const another = () => {
    setDraft((current) => {
      return pick(messages.filter((message) => message !== current));
    });
    field.current?.focus();
  };

  const send = async (thread: string) => {
    const content = draft.trim();

    if (disabled || !content) {
      return;
    }

    const event = eventOfMessage(target.agent, thread, content);

    setDraft(pick(messages.filter((message) => message !== content)));
    await api.send(target.agent, thread, content);
    setSent((previous) => {
      return [JSON.stringify(event, null, 2), ...previous].slice(0, 6);
    });
  };

  useAction("sendEvent", () => {
    void send(threads[0] ?? target.thread);
  });
  useAction("sendOther", () => {
    if (threads[1]) {
      void send(threads[1]);
    }
  });

  return (
    <div className="message">
      <p>A message is an event.</p>
      <div className="message-box">
        <input
          ref={field}
          type="text"
          className="message-text"
          aria-label="Message"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void send(threads[0] ?? target.thread);
            }
          }}
        />
        <button type="button" onClick={another}>
          another
        </button>
      </div>
      <div className="message-buttons">
        {threads.length > 1 ? (
          threads.map((thread, at) => {
            return (
              <button
                type="button"
                className="primary"
                key={thread}
                disabled={disabled || !draft.trim()}
                onClick={() => {
                  void send(thread);
                }}
              >
                Send to {thread}{" "}
                <Kbd action={at === 0 ? "sendEvent" : "sendOther"} />
              </button>
            );
          })
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled || !draft.trim()}
            onClick={() => {
              void send(target.thread);
            }}
          >
            Send a message <Kbd action="sendEvent" />
          </button>
        )}
      </div>
      {sent.map((json, at) => {
        return (
          <pre className="sent" key={`${at}-${json}`}>
            Sent {json}
          </pre>
        );
      })}
    </div>
  );
};
