/**
 * @module
 * The Messages tab of the play pane. A button sends a random message as an
 * event, and the tab shows
 * each message as the event it became.
 */
import { useState } from "react";
import { eventOfMessage } from "../../shared/events.ts";
import { api } from "./api.ts";
import { Kbd } from "./keyboard.tsx";
import { useAction } from "./live.ts";
import { messages, pick } from "./random.ts";

export const MessagePanel = ({
  target,
  disabled,
}: {
  target: { agent: string; thread: string; threads?: string[] };
  disabled: boolean;
}) => {
  const [sent, setSent] = useState<string[]>([]);
  const threads = target.threads ?? [];

  const send = async (thread: string) => {
    if (disabled) {
      return;
    }

    const event = eventOfMessage(target.agent, thread, pick(messages));

    await api.send(target.agent, thread, event.data.content);
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
      <p>
        A message is an event: it reaches the inbox of{" "}
        <code>{target.agent}</code> on a thread.
      </p>
      <div className="message-buttons">
        {threads.length > 1 ? (
          threads.map((thread, at) => {
            return (
              <button
                type="button"
                className="primary"
                key={thread}
                disabled={disabled}
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
            disabled={disabled}
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
