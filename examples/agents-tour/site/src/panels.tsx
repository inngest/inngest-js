/**
 * @module
 * The message box of the play pane. Typing a message sends an event, and the
 * box shows each message as the event it became.
 */
import { useRef, useState } from "react";
import { eventOfMessage } from "../../shared/events.ts";
import { api } from "./api.ts";
import { Kbd } from "./keyboard.tsx";
import { useAction } from "./live.ts";

export const MessagePanel = ({
  target,
  disabled,
}: {
  target: { agent: string; thread: string };
  disabled: boolean;
}) => {
  const [text, setText] = useState("Hello");
  const [sent, setSent] = useState<string[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);

  useAction("message", () => {
    box.current?.focus();
  });

  const send = async () => {
    if (!text.trim() || disabled) {
      return;
    }

    const body = text;
    const event = eventOfMessage(target.agent, target.thread, body);

    setText("");
    box.current?.focus();
    await api.send(target.agent, target.thread, body);
    setSent((previous) => {
      return [JSON.stringify(event, null, 2), ...previous].slice(0, 6);
    });
  };

  return (
    <form
      className="message"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p>
        Say something to <code>{target.agent}</code>. A message is an event: it
        reaches the agent's inbox on thread <code>{target.thread}</code>.
      </p>
      <label>
        Message
        <textarea
          ref={box}
          value={text}
          rows={2}
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
      </label>
      <button type="submit" className="primary" disabled={disabled}>
        Send <kbd>Enter</kbd>
      </button>
      {sent.map((json, at) => {
        return (
          <pre className="sent" key={`${at}-${json}`}>
            Sent {json}
          </pre>
        );
      })}
    </form>
  );
};
