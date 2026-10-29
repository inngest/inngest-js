/**
 * @module
 * The panels under the editor: Output, Trace and the message box.
 */
import { useEffect, useRef, useState } from "react";
import type { TourEvent, TraceRun, TraceStep } from "../../shared/types.ts";
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

const housekeeping = (step: TraceStep) => {
  return /^(kv\.|inbox:|executor\.)/.test(step.name);
};

const label = (step: TraceStep) => {
  if (step.name === "executor.nonstep") {
    return "Function code";
  }

  return step.name;
};

const rounded = (ms: number | null) => {
  if (ms === null) {
    return "";
  }

  if (ms < 1000) {
    return `${Math.max(100, Math.round(ms / 100) * 100)} ms`.replace("100 ms", "<100 ms");
  }

  return `${(ms / 1000).toFixed(1)} s`;
};

const Step = ({ step }: { step: TraceStep }) => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string>("");

  const toggle = async () => {
    const next = !open;

    setOpen(next);

    if (next && step.outputID && !detail) {
      const out = await api.output(step.outputID).catch(() => {
        return null;
      });

      setDetail(
        out
          ? JSON.stringify({ input: out.input, output: out.data, error: out.error?.message }, null, 2)
          : "No data",
      );
    }
  };

  return (
    <li>
      <button type="button" className="step" onClick={toggle} aria-expanded={open}>
        <span className={`dot ${step.status.toLowerCase()}`} aria-hidden="true" />
        <span className="step-name">{label(step)}</span>
        <span className="step-meta">{rounded(step.duration)}</span>
      </button>
      {open ? <pre className="step-detail">{detail || "No data"}</pre> : null}
    </li>
  );
};

const RunView = ({ run, everything }: { run: TraceRun; everything: boolean }) => {
  const shown = run.steps.filter((step) => {
    return everything || !housekeeping(step);
  });
  const hidden = run.steps.length - shown.length;

  return (
    <section className="run" aria-label={`Run of ${run.fn}`}>
      <header>
        <span className={`dot ${run.status.toLowerCase()}`} aria-hidden="true" />
        <strong>{run.fn}</strong>
        <span className="status">{run.status.toLowerCase()}</span>
      </header>
      {shown.length > 0 ? (
        <ul>
          {shown.map((step) => {
            return <Step step={step} key={step.id} />;
          })}
        </ul>
      ) : (
        <p className="empty">No steps of your own yet.</p>
      )}
      {hidden > 0 ? (
        <p className="hidden-note">{hidden} housekeeping steps hidden</p>
      ) : null}
    </section>
  );
};

export const TracePanel = ({
  runs,
  everything,
  onToggle,
  hint,
}: {
  runs: TraceRun[];
  everything: boolean;
  onToggle: () => void;
  hint: React.ReactNode;
}) => {
  return (
    <div className="trace" tabIndex={0} aria-label="Trace">
      <div className="trace-bar">
        <span>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
        <button type="button" className="ghost" onClick={onToggle} aria-pressed={everything}>
          Show everything {hint}
        </button>
      </div>
      {runs.length === 0 ? <p className="empty">Press Run to see the trace here.</p> : null}
      {runs.map((run) => {
        return <RunView run={run} everything={everything} key={run.id} />;
      })}
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
    if (text.trim()) {
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
        Say something to <code>{target.agent}</code>. Messages with the same thread reach the same agent.
      </p>
      <label>
        Thread
        <input value={thread} onChange={(event) => setThread(event.target.value)} />
      </label>
      <label>
        Message
        <textarea
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
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
