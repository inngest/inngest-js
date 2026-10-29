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
  target: { agent: string; thread: string };
  disabled: boolean;
}) => {
  const [sent, setSent] = useState<string[]>([]);

  const send = async () => {
    if (disabled) {
      return;
    }

    const event = eventOfMessage(target.agent, target.thread, pick(messages));

    await api.send(target.agent, target.thread, event.data.content);
    setSent((previous) => {
      return [JSON.stringify(event, null, 2), ...previous].slice(0, 6);
    });
  };

  useAction("sendEvent", () => {
    void send();
  });

  return (
    <div className="message">
      <p>
        A message is an event: it reaches the inbox of{" "}
        <code>{target.agent}</code> on thread <code>{target.thread}</code>.
      </p>
      <button
        type="button"
        className="primary"
        disabled={disabled}
        onClick={() => {
          void send();
        }}
      >
        Send a message <Kbd action="sendEvent" />
      </button>
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
