/**
 * @module
 * The panels under the editor: Output and the message box.
 */
import { useEffect, useRef, useState } from "react";
import type { TourEvent } from "../../shared/types.ts";
import { api } from "./api.ts";

type Line = Extract<TourEvent, { type: "log" }>;

export const OutputPanel = ({ lines }: { lines: Line[] }) => {
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="output" role="log" aria-label="Output" tabIndex={0}>
      {lines.length === 0 ? (
        <p className="empty">Press Run to see output here.</p>
      ) : null}
      {lines.map((line, index) => {
        return (
          <div className={`line ${line.kind}`} key={`${index}-${line.text}`}>
            {line.text}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
};

export const MessagePanel = ({
  target,
  disabled,
}: {
  target: { agent: string; thread: string };
  disabled: boolean;
}) => {
  const [thread, setThread] = useState(target.thread);
  const [text, setText] = useState("Hello");

  useEffect(() => {
    setThread(target.thread);
  }, [target.thread]);

  const send = async () => {
    if (text.trim() && !disabled) {
      await api.send(target.agent, thread, text);
    }
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
        Say something to <code>{target.agent}</code>. Messages with the same
        thread reach the same agent.
      </p>
      <label>
        Thread
        <input
          value={thread}
          onChange={(event) => setThread(event.target.value)}
        />
      </label>
      <label>
        Message
        <textarea
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
    </form>
  );
};
