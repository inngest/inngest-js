/**
 * @module
 * The event sender: a name and JSON data, sent to the Dev Server as an event.
 */
import { useRef, useState } from "react";
import { Kbd } from "./keyboard.tsx";
import { postJson, useAction } from "./live.ts";

export const Events = () => {
  const [name, setName] = useState("tour/greet");
  const [data, setData] = useState('{\n  "name": "Ada"\n}');
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState("");
  const nameBox = useRef<HTMLInputElement>(null);
  const latest = useRef({ name, data });

  latest.current = { name, data };

  const send = async () => {
    const { name: eventName, data: text } = latest.current;
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      setError("The data is not valid JSON.");

      return;
    }

    if (!eventName.trim()) {
      setError("An event needs a name.");

      return;
    }

    const result = await postJson("/api/event", {
      name: eventName.trim(),
      data: parsed,
    });

    if (result.error) {
      setError(String(result.error));

      return;
    }

    setError("");
    setSent((previous) => {
      return [
        JSON.stringify({ name: eventName.trim(), data: parsed }, null, 2),
        ...previous,
      ].slice(0, 6);
    });
  };

  useAction("sendEvent", () => {
    void send();
  });

  return (
    <form
      className="events"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label>
        Event name
        <input
          ref={nameBox}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Data (JSON)
        <textarea
          value={data}
          rows={4}
          onChange={(event) => setData(event.target.value)}
        />
      </label>
      <button type="submit" className="primary">
        Send the event <Kbd action="sendEvent" />
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
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
