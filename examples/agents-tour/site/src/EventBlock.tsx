/**
 * @module
 * The end of a page's prose: the exact event Run sends, as highlighted JSON.
 * It reads the same `eventOfStart` the server sends from, so it cannot drift.
 */
import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { eventOfStart } from "../../shared/events.ts";
import type { Start } from "../../shared/types.ts";

interface Props {
  starts: Start[];
  dark: boolean;
}

export const EventBlock = (props: Props) => {
  const code = useRef<HTMLElement>(null);
  const events = props.starts.map(eventOfStart);
  const json = JSON.stringify(
    events.length === 1 ? events[0] : events,
    null,
    2,
  );

  useEffect(() => {
    let current = true;

    // Colors come from the active editor theme, which `dark` switches.
    void monaco.editor
      .colorize(json, "typescript", { tabSize: 2 })
      .then((html) => {
        if (current && code.current) {
          code.current.innerHTML = html;
        }
      });

    return () => {
      current = false;
    };
  }, [json, props.dark]);

  return (
    <>
      <p>
        {events.length === 1
          ? "Let's run the agent with this event:"
          : "Let's run the agent with these events:"}
      </p>
      <pre className="event-block">
        <code ref={code}>{json}</code>
      </pre>
    </>
  );
};
