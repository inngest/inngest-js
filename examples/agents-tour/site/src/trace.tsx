/**
 * @module
 * The Trace panel: a waterfall of the real spans the Dev Server returns, one
 * row per span, a bar on a shared timeline, indentation from group spans.
 * Housekeeping spans (inbox opens, KV reads, the executor's own span) are
 * collapsed by rule into one muted "n hidden" row; "Show everything" lists
 * the raw tree. Up and down move between rows, Enter opens one.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceRun, TraceStep } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Kbd } from "./keyboard.tsx";

const housekeepingName =
  /^(kv\.|inbox:\d+:(open|close|stop)$|executor\.|metadata)/;

const isHousekeeping = (step: TraceStep) => {
  return housekeepingName.test(step.name);
};

// A gap this long between two steps of a run is the run parked, waiting for
// a message: the executor stores no span for a park.
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
  opened: Set<string>,
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

    const key = `${prefix}h:${pending[0]?.id}`;

    if (opened.has(key)) {
      for (const step of pending) {
        rows.push({ kind: "step", key: `${prefix}${step.id}`, step, depth });
      }
    } else {
      rows.push({ kind: "hidden", key, steps: pending, depth });
    }

    pending = [];
  };

  for (const step of steps) {
    const start = time(step.startedAt);

    if (
      depth === 0 &&
      !isHousekeeping(step) &&
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
          opened,
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

const Detail = ({ outputID }: { outputID: string | null }) => {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!outputID) {
      setText("No data");

      return;
    }

    void api
      .output(outputID)
      .then((out) => {
        setText(
          JSON.stringify(
            { input: out.input, output: out.data, error: out.error?.message },
            null,
            2,
          ),
        );
      })
      .catch(() => {
        setText("No data");
      });
  }, [outputID]);

  return <pre className="step-detail">{text || "Loading..."}</pre>;
};

const Run = ({
  run,
  everything,
  now,
}: {
  run: TraceRun;
  everything: boolean;
  now: number;
}) => {
  const [open, setOpen] = useState<Set<string>>(new Set());
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
    return rowsOf(run.steps, everything, open, now, live);
  }, [run.steps, everything, open, now, live]);

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
  const t1 = Math.max(
    ...all,
    live ? now : (time(run.endedAt) ?? t0),
    t0 + 500,
  );
  const span = t1 - t0;
  const bar = (from: number, to: number) => {
    return {
      left: `${((from - t0) / span) * 100}%`,
      width: `${Math.max(0.8, ((to - from) / span) * 100)}%`,
    };
  };

  return (
    <section className="run" aria-label={`Run of ${run.fn}`}>
      <header>
        <span
          className={`dot ${run.status.toLowerCase()}`}
          aria-hidden="true"
        />
        <strong>{run.fn}</strong>
        <span className="status">{run.status.toLowerCase()}</span>
        <span className="run-total">{rounded(t1 - t0)}</span>
      </header>
      <div className="wf" role="list">
        {rows.map((row) => {
          const pad = { paddingLeft: 12 + row.depth * 16 };

          if (row.kind === "hidden") {
            return (
              <div role="listitem" key={row.key}>
                <button
                  type="button"
                  className="wf-row hidden-row"
                  data-row
                  style={pad}
                  onClick={() => toggle(row.key)}
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
                  <span className="dot waiting" aria-hidden="true" />
                  <span className="wf-name">
                    inbox.next{" "}
                    <em>{row.live ? "waiting for a message" : "waited"}</em>
                  </span>
                  <span className="wf-track">
                    <i className="wf-bar waiting" style={bar(row.from, row.to)} />
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
                <span
                  className={`dot ${step.status.toLowerCase()}`}
                  aria-hidden="true"
                />
                <span className="wf-name">
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

export const TracePanel = ({
  runs,
  everything,
  onToggle,
}: {
  runs: TraceRun[];
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
      {runs.length === 0 ? (
        <p className="empty">Press Run to see the trace here.</p>
      ) : null}
      {[...runs].reverse().map((run) => {
        return <Run run={run} everything={everything} now={now} key={run.id} />;
      })}
    </div>
  );
};
