/**
 * @module
 * The event sender: one button that sends a `tour/greet` event for a random
 * name, and the list of what it sent.
 */
import { useState } from "react";
import { Kbd } from "./keyboard.tsx";
import { postJson, useAction } from "./live.ts";
import { names, pick } from "./random.ts";

export const Events = () => {
  const [sent, setSent] = useState<string[]>([]);

  const send = async () => {
    const event = { name: "tour/greet", data: { name: pick(names) } };

    await postJson("/api/event", event);
    setSent((previous) => {
      return [JSON.stringify(event, null, 2), ...previous].slice(0, 6);
    });
  };

  useAction("sendEvent", () => {
    void send();
  });

  return (
    <div className="events">
      <p>
        Send a <code>tour/greet</code> event for a random name.
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => {
          void send();
        }}
      >
        Send an event <Kbd action="sendEvent" />
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
