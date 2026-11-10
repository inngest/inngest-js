/**
 * @module
 * The Chat panel: the chatbot the reader is building. The reader's messages
 * are bubbles on the right, the agent's answers bubbles on the left, and
 * everything the agent *does* is a plain line between them: a tool call, a
 * skill it opened, an inbox it started listening on, another agent it found,
 * started, messaged or asked.
 *
 * The lines come from the same spans the Trace draws, through the same
 * `isPlumbing` rule, so the reader sees their agent's own actions and never
 * the SDK's internals. A span the SDK left on its own (subscribe, inbox,
 * close, thread state, the ledger's reads) is not a line; a model call is a
 * bubble, not a line; everything else the run recorded is a line.
 *
 * Typing in the chat box saves and runs the page first when the code has
 * unsaved edits, so clicking out of the editor is all it takes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunFailure, TraceRun, TraceStep } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Kbd } from "./keyboard.tsx";
import { useAction } from "./live.ts";
import { Fit, Reveal } from "./motion.tsx";
import {
  Detail,
  FailedRun,
  isFinalization,
  isNextCall,
  isPlaceholder,
  isPlumbing,
  parse,
  type RunPressed,
} from "./trace.tsx";

/**
 * Where the chat sends what the reader types.
 */
export interface ChatTarget {
  agent: string;
  thread: string;
  // More than one thread gives the chat a thread switcher.
  threads?: string[];
  // Things the page suggests asking, shown as buttons under the box.
  prompts?: string[];
}

// The step the SDK records for a model call. Its output is the model's reply,
// so its text is what the agent said.
const isThinking = (step: TraceStep) => {
  return step.name === "Thinking" || step.type === "llm" || step.group === "llm";
};

// A line's words for the tools the SDK gives a model, so the reader reads
// what happened rather than a tool name. Any other tool keeps its own name,
// which is the name the reader wrote.
const saidAs: Record<string, string> = {
  list_agents: "looked for other agents",
  describe_agent: "read another agent's card",
  start_agent: "started another agent",
  message_agent: "messaged another agent",
  ask_agent: "asked another agent",
  stop_agent: "stopped another agent",
  inbox_listen: "started listening for an event",
  inbox_close: "stopped listening",
  open_skill: "opened a skill",
  report: "reported back",
};

export type ChatRow =
  | {
      kind: "said";
      key: string;
      who: "reader" | "agent";
      text: string;
      at: number;
      depth: number;
      agent?: string;
    }
  | {
      kind: "did";
      key: string;
      label: string;
      status: string;
      outputID: string | null;
      at: number;
      depth: number;
      agent?: string;
    };

const time = (iso: string | null) => {
  return iso ? new Date(iso).getTime() : 0;
};

/**
 * Every step of a run that is a line or a bubble, in the order it started.
 * A plumbing span, a placeholder, Finalization and an `inbox.next()` call are
 * none of those: the reader did not ask for them.
 */
const actionsOf = (steps: TraceStep[]): TraceStep[] => {
  return steps
    .flatMap((step) => {
      const own =
        isPlaceholder(step) ||
        isFinalization(step) ||
        isNextCall(step) ||
        isPlumbing(step)
          ? []
          : [step];

      return [...own, ...actionsOf(step.children)];
    })
    .sort((one, two) => {
      return time(one.startedAt) - time(two.startedAt);
    });
};

const contentOf = (run: TraceRun) => {
  const data = run.trigger?.data ?? {};
  const content = data.content ?? data.text ?? data.message;

  return typeof content === "string" ? content : null;
};

const threadOf = (run: TraceRun) => {
  const thread = run.trigger?.data.thread;

  return typeof thread === "string" ? thread : null;
};

/**
 * The rows of the whole conversation: every run of the thread, oldest first,
 * each run's trigger as the reader's message and each of its actions as a
 * bubble or a line. A run of another agent (one this agent started) is
 * indented and named, so a handoff reads as a handoff.
 */
export const rowsOf = (
  runs: TraceRun[],
  primary: string | null,
  texts: Map<string, string>,
): ChatRow[] => {
  const rows: ChatRow[] = [];

  for (const run of runs) {
    const mine = primary === null || run.fn === primary;
    const depth = mine ? 0 : 1;
    const agent = mine ? undefined : run.fn;
    const content = contentOf(run);
    const started = time(run.queuedAt);

    if (content !== null) {
      rows.push({
        kind: "said",
        key: `${run.id}:trigger`,
        who: mine ? "reader" : "agent",
        text: content,
        at: started,
        depth,
        agent,
      });
    } else if (run.trigger) {
      rows.push({
        kind: "did",
        key: `${run.id}:trigger`,
        label: `${run.trigger.name} arrived`,
        status: "COMPLETED",
        outputID: null,
        at: started,
        depth,
        agent,
      });
    }

    for (const step of actionsOf(run.steps)) {
      const at = time(step.startedAt);

      if (isThinking(step)) {
        const text = step.outputID ? texts.get(step.outputID) : undefined;

        if (text) {
          rows.push({
            kind: "said",
            key: `${run.id}:${step.id}`,
            who: "agent",
            text,
            at,
            depth,
            agent,
          });
        }

        continue;
      }

      rows.push({
        kind: "did",
        key: `${run.id}:${step.id}`,
        label: saidAs[step.name] ?? step.name,
        status: step.status,
        outputID: step.outputID,
        at,
        depth,
        agent,
      });
    }
  }

  return rows;
};

/**
 * The text of each model call, read once per output and kept. A step's output
 * never changes once the step has ended, so a read is never repeated.
 */
const useSaid = (runs: TraceRun[]) => {
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const wanted = useMemo(() => {
    const ids: string[] = [];
    const walk = (steps: TraceStep[]) => {
      for (const step of steps) {
        if (isThinking(step) && step.outputID && step.status === "COMPLETED") {
          ids.push(step.outputID);
        }

        walk(step.children);
      }
    };

    for (const run of runs) {
      walk(run.steps);
    }

    return ids;
  }, [runs]);

  useEffect(() => {
    for (const id of wanted) {
      if (asked.current.has(id)) {
        continue;
      }

      asked.current.add(id);

      void api
        .output(id)
        .then((out) => {
          const reply = parse(out.data);
          const text =
            reply && typeof reply === "object" && "text" in reply
              ? (reply as { text?: unknown }).text
              : undefined;

          if (typeof text === "string" && text.trim() !== "") {
            setTexts((previous) => {
              return new Map(previous).set(id, text.trim());
            });
          }
        })
        .catch(() => {
          // The Dev Server is restarting; the next snapshot asks again.
          asked.current.delete(id);
        });
    }
  }, [wanted]);

  return texts;
};

const Bubble = ({ row }: { row: Extract<ChatRow, { kind: "said" }> }) => {
  return (
    <div
      className={`chat-line ${row.who}`}
      style={{ paddingLeft: row.depth * 18 }}
    >
      <div className="bubble">
        {row.agent ? <strong className="chat-who">{row.agent}</strong> : null}
        {row.text}
      </div>
    </div>
  );
};

const Did = ({ row }: { row: Extract<ChatRow, { kind: "did" }> }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="chat-line did" style={{ paddingLeft: row.depth * 18 }}>
      <button
        type="button"
        className={`chat-did ${row.status.toLowerCase()}`}
        data-row
        aria-expanded={open}
        disabled={!row.outputID}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-dot" aria-hidden="true" />
        {row.agent ? <em className="chat-who">{row.agent}</em> : null}
        {row.label}
      </button>
      <Reveal show={open && row.outputID !== null}>
        <Detail outputID={row.outputID} />
      </Reveal>
    </div>
  );
};

export const ChatPanel = ({
  runs,
  target,
  live,
  dirty,
  pressed,
  failure,
  onRun,
  onJump,
}: {
  runs: TraceRun[];
  // Where to send, when the page says. Without one the chat reads the
  // conversation and the box is closed.
  target: ChatTarget | null;
  // True while the reader's app is serving.
  live: boolean;
  // True while the editor holds edits the app has not been given.
  dirty: boolean;
  pressed: RunPressed | null;
  failure: RunFailure | null;
  // Saves and runs the page, and resolves once Run has been sent.
  onRun: () => Promise<void>;
  onJump: (failure: RunFailure) => void;
}) => {
  const threads = target?.threads ?? [];
  const [thread, setThread] = useState(target?.thread ?? "");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<string[]>([]);
  const box = useRef<HTMLInputElement>(null);
  const foot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setThread(target?.thread ?? "");
  }, [target?.thread]);

  const texts = useSaid(runs);
  const ours = useMemo(() => {
    return runs.filter((run) => {
      const key = threadOf(run);

      return thread === "" || key === null || key === thread;
    });
  }, [runs, thread]);
  const rows = useMemo(() => {
    return rowsOf(ours, target?.agent ?? null, texts);
  }, [ours, target?.agent, texts]);
  const working = ours.some((run) => {
    return !["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(
      run.status,
    );
  });

  // The newest line is the one the reader wants to see.
  useEffect(() => {
    foot.current?.scrollIntoView({ block: "end" });
  }, [rows.length, sending.length, working]);

  const send = async (text: string) => {
    const content = text.trim();

    if (!target || content === "") {
      return;
    }

    setDraft("");
    setSending((previous) => {
      return [...previous, content];
    });

    // Clicking out of the editor to type here is a save and a Run: the app
    // the message reaches is the code on screen, never the code before it.
    if (dirty) {
      await onRun();
    }

    try {
      await api.send(target.agent, thread || target.thread, content);
    } finally {
      setSending((previous) => {
        return previous.filter((one) => {
          return one !== content;
        });
      });
    }
  };

  useAction("chatSend", () => {
    void send(draft);
  });
  useAction("chat", () => {
    box.current?.focus();
  });

  const closed = !target;

  return (
    <div className="chat" aria-label="Chat">
      <div className="chat-scroll">
        {rows.length === 0 && sending.length === 0 && !pressed ? (
          <p className="empty">
            {closed
              ? "This page has no chat. Press Run and read the Trace."
              : "Say something to your agent."}
          </p>
        ) : null}
        {rows.map((row) => {
          return row.kind === "said" ? (
            <Bubble key={row.key} row={row} />
          ) : (
            <Did key={row.key} row={row} />
          );
        })}
        {sending.map((text) => {
          return (
            <div className="chat-line reader sending" key={`sending:${text}`}>
              <div className="bubble">{text}</div>
            </div>
          );
        })}
        <Reveal show={working} appear>
          <div className="chat-line agent">
            <div className="bubble thinking" aria-label="Working">
              <span className="dot running" aria-hidden="true" />
              working
            </div>
          </div>
        </Reveal>
        <Fit>
          {failure ? (
            <FailedRun failure={failure} onJump={onJump} />
          ) : (
            <span />
          )}
        </Fit>
        <div ref={foot} />
      </div>
      {closed ? null : (
        <div className="chat-box">
          {threads.length > 1 ? (
            <div className="chat-threads" role="tablist" aria-label="Threads">
              {threads.map((one) => {
                return (
                  <button
                    type="button"
                    role="tab"
                    key={one}
                    aria-selected={thread === one}
                    onClick={() => setThread(one)}
                  >
                    {one}
                  </button>
                );
              })}
            </div>
          ) : null}
          {target.prompts?.length ? (
            <div className="chat-prompts">
              {target.prompts.map((prompt) => {
                return (
                  <button
                    type="button"
                    className="ghost"
                    key={prompt}
                    onClick={() => {
                      void send(prompt);
                    }}
                  >
                    {prompt}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="chat-entry">
            <input
              ref={box}
              type="text"
              className="chat-text"
              aria-label="Message"
              placeholder={dirty ? "Saves and runs, then sends" : "Say something"}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={!live && !dirty}
              onClick={() => {
                void send(draft);
              }}
            >
              Send <Kbd action="chatSend" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
