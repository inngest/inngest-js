/**
 * @module
 * The Trace panel: a waterfall of the real spans the Dev Server returns, one
 * row per span, a bar on a shared timeline, indentation from group spans.
 * Housekeeping spans (inbox opens, KV reads, the executor's own span) are
 * collapsed by rule into one muted "n hidden" row; "Show everything" lists
 * the raw tree. Up and down move between rows, Enter opens one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TourEvent, TraceRun, TraceStep } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Kbd } from "./keyboard.tsx";

const housekeepingName =
  /^(kv\.|inbox:\d+:(open|close|stop)$|executor\.|metadata)/;

const isHousekeeping = (step: TraceStep) => {
  return housekeepingName.test(step.name);
};

// A gap this long between two steps of a run is the run parked, waiting for
// a message: the executor stores no span for a park, so the gap is the
// `inbox.next()` row, whatever (even housekeeping) step ends it.
const waitGapMs = 600;

type Row =
  | { kind: "step"; key: string; step: TraceStep; depth: number }
  | { kind: "hidden"; key: string; steps: TraceStep[]; depth: number }
  | {
      kind: "wait";
      key: string;
      from: number;
      to: number;
      live: boolean;
      depth: number;
    };

const time = (iso: string | null) => {
  return iso ? new Date(iso).getTime() : null;
};

const endOf = (step: TraceStep, now: number): number | null => {
  const start = time(step.startedAt);

  if (start === null) {
    return null;
  }

  return time(step.endedAt) ?? (step.status === "RUNNING" ? now : start);
};

type IconKind = "inbox" | "event" | "step" | "kv" | "wait" | "agent" | "code";

const kindOf = (step: TraceStep): IconKind => {
  if (/^inbox/.test(step.name)) {
    return "inbox";
  }

  if (/^kv\./.test(step.name)) {
    return "kv";
  }

  if (/sleep|wait/i.test(step.name) || step.type === "step.sleep") {
    return "wait";
  }

  if (step.name === "executor.nonstep") {
    return "code";
  }

  if (step.group || step.children.length > 0) {
    return "agent";
  }

  return "step";
};

const paths: Record<IconKind, string> = {
  inbox: "M2 4h12v8H2zM2 4l6 5 6-5",
  event: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  step: "M4 3l8 5-8 5z",
  kv: "M10.5 2a3.5 3.5 0 1 0 .6 6.9L14 12v2h-2v-1.5H10.5V11H9L7.2 9.2A3.5 3.5 0 0 0 10.5 2z",
  wait: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 5v3.5L10.5 10",
  agent: "M2 4h12M2 8h9M2 12h6",
  code: "M6 4 2 8l4 4M10 4l4 4-4 4",
};

const Icon = ({ kind }: { kind: IconKind }) => {
  return (
    <svg
      className="wf-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
};

const label = (step: TraceStep) => {
  if (step.name === "executor.nonstep") {
    return "Function code";
  }

  return step.name;
};

const rounded = (ms: number) => {
  if (ms < 100) {
    return "<100 ms";
  }

  if (ms < 1000) {
    return `${Math.round(ms / 100) * 100} ms`;
  }

  return `${(ms / 1000).toFixed(1)} s`;
};

const rowsOf = (
  steps: TraceStep[],
  everything: boolean,
  now: number,
  live: boolean,
  depth = 0,
  prefix = "",
) => {
  const rows: Row[] = [];
  let pending: TraceStep[] = [];
  let lastEnd: number | null = null;

  const flush = () => {
    if (pending.length === 0) {
      return;
    }

    rows.push({
      kind: "hidden",
      key: `${prefix}h:${pending[0]?.id}`,
      steps: pending,
      depth,
    });

    pending = [];
  };

  for (const step of steps) {
    const start = time(step.startedAt);

    if (
      depth === 0 &&
      lastEnd !== null &&
      start !== null &&
      start - lastEnd > waitGapMs
    ) {
      flush();
      rows.push({
        kind: "wait",
        key: `${prefix}w:${step.id}`,
        from: lastEnd,
        to: start,
        live: false,
        depth,
      });
    }

    if (!everything && isHousekeeping(step)) {
      pending.push(step);
    } else {
      flush();
      rows.push({ kind: "step", key: `${prefix}${step.id}`, step, depth });
      rows.push(
        ...rowsOf(
          step.children,
          everything,
          now,
          live,
          depth + 1,
          `${prefix}${step.id}/`,
        ),
      );
    }

    const end = endOf(step, now);

    if (end !== null && (lastEnd === null || end > lastEnd)) {
      lastEnd = end;
    }
  }

  flush();

  if (depth === 0 && live && lastEnd !== null && now - lastEnd > waitGapMs) {
    rows.push({
      kind: "wait",
      key: `${prefix}w:live`,
      from: lastEnd,
      to: now,
      live: true,
      depth,
    });
  }

  return rows;
};

// Text that is JSON is parsed, even when it is JSON inside a string.
const parse = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "string" ? parse(value) : value;
  } catch {
    return text;
  }
};

const token =
  /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * Pretty JSON with the keys, strings, numbers and booleans in colour.
 */
export const Json = ({ value }: { value: unknown }) => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let offset = 0;

  return (
    <pre className="step-detail">
      {text.split(token).map((part) => {
        const at = offset;

        offset += part.length;

        if (typeof value === "string") {
          return part;
        }

        let kind = "";

        if (part.startsWith('"')) {
          kind = part.endsWith(":") ? "jv-key" : "jv-string";
        } else if (/^(true|false|null)$/.test(part)) {
          kind = "jv-bool";
        } else if (/^-?\d/.test(part)) {
          kind = "jv-number";
        }

        return kind ? (
          <span className={kind} key={at}>
            {part}
          </span>
        ) : (
          part
        );
      })}
    </pre>
  );
};

const Detail = ({ outputID }: { outputID: string | null }) => {
  const [out, setOut] = useState<
    | { error: { name: string | null; message: string; stack?: string } }
    | { value: unknown }
    | undefined
  >();

  useEffect(() => {
    if (!outputID) {
      setOut({ value: undefined });

      return;
    }

    void api
      .output(outputID)
      .then((result) => {
        setOut(
          result.error
            ? { error: result.error }
            : { value: parse(result.data) },
        );
      })
      .catch(() => {
        setOut({ value: undefined });
      });
  }, [outputID]);

  if (!out) {
    return <pre className="step-detail">Loading...</pre>;
  }

  if ("error" in out) {
    const stack = (out.error.stack ?? "").split("\n").slice(1, 4).join("\n");

    return (
      <pre className="step-detail error-detail">
        {out.error.name ?? "Error"}: {out.error.message}
        {stack ? `\n${stack}` : ""}
      </pre>
    );
  }

  return out.value === undefined ? (
    <pre className="step-detail">No value</pre>
  ) : (
    <Json value={out.value} />
  );
};

const Result = ({ run }: { run: TraceRun }) => {
  const [text, setText] = useState<{ error: boolean; value: string }>();

  useEffect(() => {
    if (!run.output) {
      setText(undefined);

      return;
    }

    void api
      .output(run.output)
      .then((out) => {
        setText(
          out.error
            ? { error: true, value: out.error.message }
            : { error: false, value: out.data ?? "" },
        );
      })
      .catch(() => {
        setText(undefined);
      });
  }, [run.output]);

  if (!text || text.value === "" || text.value === "null") {
    return null;
  }

  return (
    <code className={text.error ? "run-output error" : "run-output"}>
      {text.error ? "failed: " : "returned "}
      {text.value}
    </code>
  );
};

const Trigger = ({ run }: { run: TraceRun }) => {
  const [open, setOpen] = useState(false);

  if (!run.trigger) {
    return null;
  }

  const message = run.trigger.name === "agent/message";

  return (
    <div>
      <button
        type="button"
        className="wf-row trigger-row"
        data-row
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wf-name">
          <Icon kind={message ? "inbox" : "event"} />
          {message ? "inbox.next()" : run.trigger.name}
        </span>
        <span className="wf-track">
          <i className="wf-bar completed" style={{ left: 0 }} />
        </span>
        <span className="wf-time" />
      </button>
      {open ? (
        <Json
          value={
            message
              ? { event: run.trigger.name, ...run.trigger.data }
              : run.trigger.data
          }
        />
      ) : null}
    </div>
  );
};

const Run = ({
  run,
  everything,
  now,
  onToggle,
}: {
  run: TraceRun;
  everything: boolean;
  now: number;
  onToggle: () => void;
}) => {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showResult, setShowResult] = useState(false);
  const live = !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
    run.status,
  );
  const toggle = (key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  };
  const rows = useMemo(() => {
    return rowsOf(run.steps, everything, now, live);
  }, [run.steps, everything, now, live]);

  const starts = [time(run.queuedAt), time(run.startedAt)].filter(
    (value): value is number => {
      return value !== null;
    },
  );
  const walk = (steps: TraceStep[], out: number[]) => {
    for (const step of steps) {
      const start = time(step.startedAt);
      const end = endOf(step, now);

      if (start !== null) {
        out.push(start);
      }

      if (end !== null) {
        out.push(end);
      }

      walk(step.children, out);
    }

    return out;
  };
  const all = walk(run.steps, [...starts]);
  const t0 = Math.min(...all, now);
  const t1 = Math.max(...all, live ? now : (time(run.endedAt) ?? t0), t0 + 500);
  const span = t1 - t0;
  const bar = (from: number, to: number) => {
    return {
      left: `min(${((from - t0) / span) * 100}%, calc(100% - 12px))`,
      width: `${Math.max(0.8, ((to - from) / span) * 100)}%`,
    };
  };

  return (
    <section className="run" aria-label={`Run of ${run.fn}`}>
      <button
        type="button"
        className="run-head"
        data-row
        aria-expanded={showResult}
        onClick={() => setShowResult(!showResult)}
      >
        <span
          className={`dot ${run.status.toLowerCase()}`}
          aria-hidden="true"
        />
        <strong>{run.fn}</strong>
        <span className="status">{run.status.toLowerCase()}</span>
        {showResult ? null : <Result run={run} />}
        <span className="run-total">{rounded(t1 - t0)}</span>
      </button>
      {showResult ? <Detail outputID={run.output} /> : null}
      <div className="wf" role="list">
        <Trigger run={run} />
        {rows.map((row) => {
          const pad = { paddingLeft: 20 + row.depth * 16 };

          if (row.kind === "hidden") {
            return (
              <div role="listitem" key={row.key}>
                <button
                  type="button"
                  className="wf-row hidden-row"
                  data-row
                  style={pad}
                  onClick={onToggle}
                >
                  <span className="wf-name">
                    {row.steps.length} hidden{" "}
                    {row.steps.length === 1 ? "step" : "steps"}
                  </span>
                  <Kbd action="rowOpen" />
                </button>
              </div>
            );
          }

          if (row.kind === "wait") {
            return (
              <div role="listitem" key={row.key}>
                <div
                  className={`wf-row wait-row ${row.live ? "live" : ""}`}
                  data-row
                  tabIndex={-1}
                  style={pad}
                >
                  <span className="wf-name">
                    <Icon kind="inbox" />
                    inbox.next()
                  </span>
                  <span className="wf-track">
                    <i
                      className="wf-bar waiting"
                      style={bar(row.from, row.to)}
                    />
                  </span>
                  <span className="wf-time">{rounded(row.to - row.from)}</span>
                </div>
              </div>
            );
          }

          const { step } = row;
          const start = time(step.startedAt);
          const end = endOf(step, now);
          const expanded = open.has(row.key);
          const attempts = step.attempts && step.attempts > 1;

          return (
            <div role="listitem" key={row.key}>
              <button
                type="button"
                className={`wf-row ${step.children.length > 0 ? "group" : ""}`}
                data-row
                style={pad}
                aria-expanded={expanded}
                onClick={() => toggle(row.key)}
              >
                <span className="wf-name">
                  <Icon kind={kindOf(step)} />
                  {label(step)}
                  {attempts ? (
                    <em className="tries"> attempt {step.attempts}</em>
                  ) : null}
                </span>
                <span className="wf-track">
                  {start !== null && end !== null ? (
                    <i
                      className={`wf-bar ${step.status.toLowerCase()}`}
                      style={bar(start, end)}
                    />
                  ) : null}
                </span>
                <span className="wf-time">
                  {step.duration === null ? "" : rounded(step.duration)}
                </span>
              </button>
              {expanded ? <Detail outputID={step.outputID} /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

type Line = Extract<TourEvent, { type: "log" }>;

const Console = ({ lines }: { lines: Line[] }) => {
  const [open, setOpen] = useState(false);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="run console">
      <button
        type="button"
        className="wf-row hidden-row"
        data-row
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="wf-name">
          console, {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
        <Kbd action="rowOpen" />
      </button>
      {open ? (
        <pre className="step-detail">
          {lines
            .map((line) => {
              return line.text;
            })
            .join("\n")}
        </pre>
      ) : null}
    </div>
  );
};

export const TracePanel = ({
  runs,
  lines,
  everything,
  onToggle,
}: {
  runs: TraceRun[];
  lines: Line[];
  everything: boolean;
  onToggle: () => void;
}) => {
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const live = runs.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  useEffect(() => {
    if (!live) {
      setNow(Date.now());

      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [live]);

  const move = (event: React.KeyboardEvent) => {
    const rows = [
      ...(box.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;

    if (event.key === "ArrowDown") {
      next = Math.min(rows.length - 1, at + 1);
    } else if (event.key === "ArrowUp") {
      next = Math.max(0, at - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = rows.length - 1;
    }

    if (next !== undefined) {
      event.preventDefault();
      rows[next]?.focus();
    }
  };

  return (
    <div
      className="trace"
      ref={box}
      aria-label="Trace"
      onKeyDown={move}
      tabIndex={-1}
    >
      <div className="trace-bar">
        <span>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
        <span className="trace-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <Kbd action="rowOpen" /> open
        </span>
        <button
          type="button"
          className="ghost"
          onClick={onToggle}
          aria-pressed={everything}
        >
          Show everything <Kbd action="everything" />
        </button>
      </div>
      {lines
        .filter((line) => {
          return line.kind === "err";
        })
        .map((line, at) => {
          return (
            <p className="notice" key={`${at}-${line.text}`}>
              {line.text}
            </p>
          );
        })}
      {runs.length === 0 ? (
        <p className="empty">
          Waiting for a run. Press Run, or send a message.
        </p>
      ) : null}
      {[...runs].reverse().map((run) => {
        return (
          <Run
            run={run}
            everything={everything}
            now={now}
            onToggle={onToggle}
            key={run.id}
          />
        );
      })}
      <Console
        lines={lines.filter((line) => {
          return line.kind === "out";
        })}
      />
    </div>
  );
};
