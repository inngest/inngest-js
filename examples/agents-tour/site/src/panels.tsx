/**
 * @module
 * The message box of the play pane. Typing a message sends an event, and the
 * box shows each message as the event it became.
 */
import { useRef, useState } from "react";
import { api } from "./api.ts";
import type { Start } from "../../shared/types.ts";
import { Kbd, shortcutsOf } from "./keyboard.tsx";
import { useAction } from "./live.ts";

export const eventOfMessage = (
  agent: string,
  thread: string,
  content: string,
) => {
  return {
    name: "agent/message",
    data: { agent: `tour/${agent}`, thread, text: content },
  };
};

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

    const event = eventOfMessage(target.agent, target.thread, text);

    await api.send(target.agent, target.thread, text);
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
        Message <Kbd action="message" />
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

const eventOfStart = (start: Start) => {
  if ("event" in start) {
    return start.event;
  }

  if ("slack" in start) {
    return { name: "slack/message", data: start.slack };
  }

  return eventOfMessage(start.agent, start.thread, start.message);
};

/**
 * The exact events Run sends, read only, so nothing about a run is magic.
 */
export const RunEvent = ({
  starts,
  open,
  onToggle,
}: {
  starts: Start[];
  open: boolean;
  onToggle: () => void;
}) => {
  if (starts.length === 0) {
    return null;
  }

  return (
    <span className="run-event">
      <button
        type="button"
        className="chip"
        aria-expanded={open}
        aria-keyshortcuts={shortcutsOf("runEvent")}
        onClick={onToggle}
      >
        Run sends <Kbd action="runEvent" />
      </button>
      {open ? (
        <pre className="run-event-json" role="note">
          {starts
            .map((start) => {
              return JSON.stringify(eventOfStart(start), null, 2);
            })
            .join("\n")}
        </pre>
      ) : null}
    </span>
  );
};
