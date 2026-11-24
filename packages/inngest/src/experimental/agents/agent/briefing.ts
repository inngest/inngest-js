/**
 * @module
 * EXPERIMENTAL: the briefing, the text the SDK adds to the system prompt of
 * the loops it builds, after the agent's own `system`. It states facts about
 * how the runtime works (protocol), never how the agent should behave
 * (policy). It has two sections:
 *
 * - `<inngest-runtime v="1">`: how turns work. It depends only on the kind of
 *   loop and the tools the model has, so it is the same, byte for byte, for
 *   every run of an agent with the same tools, and caches across runs.
 * - `<inngest-situation>`: this run. Who the agent is, who started the
 *   thread, where its final text goes, the reports it owes, how long the run
 *   stays open, its limits, and what its tools say about themselves (the
 *   `context` of their descriptions).
 *
 * It is built once at the start of each run. What changes during a run
 * reaches the model as a message, never as an edit to the system prompt.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { McpServer } from "../../../components/sandbox/mcp.ts";
import {
  shapeOf,
  toolContextOf,
} from "../../../components/sandbox/toolDescription.ts";
import type { SandboxTools } from "../../../components/sandbox/tools.ts";
import type { JsonSchema } from "../json.ts";
import { isTurnEnder } from "../loop/endsTurn.ts";

/**
 * The version of the briefing's wording, shown on its runtime tag so a trace
 * says which text a run saw. Any change of wording is a new version.
 */
export const briefingVersion = 1;

/**
 * EXPERIMENTAL: someone who starts a thread or sends the message that opens a
 * run: an agent (its address and, when known, its thread key) or a plain
 * function (its run ID).
 */
export type BriefingParty =
  | { kind: "agent"; address: string; thread?: string }
  | { kind: "function"; run: string };

/**
 * EXPERIMENTAL: a report the run owes.
 */
export interface BriefingReport {
  type: string;
  required: boolean;
  schema?: JsonSchema;

  /**
   * The addresses of the agents it goes to.
   */
  to: string[];
}

/**
 * EXPERIMENTAL: what the briefing is made from. Every fact is known when the
 * run starts.
 */
export interface BriefingFacts {
  /**
   * The agent's address, `"<app>/<id>"`.
   */
  agent: string;

  /**
   * The thread's key.
   */
  thread: string;

  /**
   * `"default"` for the SDK's own handler (the run hands each batch of
   * messages to the model), `"handler"` for a handler of the agent's own,
   * whose code calls the loop.
   */
  loop: "default" | "handler";

  /**
   * The agent that started this thread, when another agent did.
   */
  starter?: BriefingParty;

  /**
   * Who sent the message that opened this run, or `undefined` when it came
   * from outside the agent team (a person, an app, a trigger). `start` is
   * true when that message started the thread (`start()` or `start_agent`):
   * the run's final text is then the sender's result.
   */
  opener?: BriefingParty & { start: boolean };

  /**
   * The reports the run owes.
   */
  reports: BriefingReport[];

  /**
   * Levels of agents still allowed below this one, when limited.
   */
  depth?: number;

  /**
   * The model's tools: their names, whether `wait` ends the turn, and the
   * `context` of each that has one.
   */
  tools: {
    names: string[];
    wait: boolean;
    contexts: { tool: string; context: string }[];
  };
}

/**
 * EXPERIMENTAL: the briefing's sections, each with its tags, by name. New
 * sections the SDK adds later appear here too.
 */
export type BriefingSections = {
  runtime: string;
  situation: string;
} & Record<string, string>;

/**
 * EXPERIMENTAL: the default briefing: its whole text and its sections.
 */
export interface Briefing {
  text: string;
  sections: BriefingSections;
}

/**
 * EXPERIMENTAL: what an agent's `briefing` option gets: the default text, its
 * sections and the facts they were made from.
 */
export interface BriefingContext extends Briefing {
  facts: BriefingFacts;
}

/**
 * EXPERIMENTAL: an agent's `briefing` option. Return a string to use in
 * place of the whole briefing, or anything falsy to send none.
 */
export type BriefingOption = (
  ctx: BriefingContext,
) => string | null | undefined | false;

/**
 * The briefing as a model request carries it. `runtime` is stable for an
 * agent with the same tools, `situation` for the run. A briefing the agent
 * replaced has an empty `runtime` and its text as `situation`.
 */
export interface BriefingParts {
  runtime: string;
  situation: string;
}

const has = (facts: BriefingFacts, name: string): boolean => {
  return facts.tools.names.includes(name);
};

const party = (who: BriefingParty): string => {
  if (who.kind === "function") {
    return `A function (run ${who.run})`;
  }

  return who.thread === undefined
    ? who.address
    : `${who.address} (thread ${who.thread})`;
};

/**
 * The runtime section's lines.
 */
const runtimeLines = (facts: BriefingFacts): string[] => {
  const turnEnd = facts.tools.wait
    ? "A turn ends when you reply without calling a tool, or when you call `wait`."
    : "A turn ends when you reply without calling a tool.";
  const lines =
    facts.loop === "handler"
      ? [
          `You are an agent running on Inngest. Your agent's code runs you: it hands you messages and takes your answer when you end your turn. ${turnEnd} Your last text goes back to that code, and you are not woken again unless the code calls you again.`,
        ]
      : [
          `You are an agent running on Inngest. You work in turns. ${turnEnd} You are then idle until a message arrives, which reaches you as the next user message.`,
        ];

  if (has(facts, "start_agent") || has(facts, "message_agent")) {
    lines.push(
      'Messages from other agents say where they come from: "Message from <agent> (thread <key>): ...", "Report "<type>" from <agent> (thread <key>): ...", "<agent> (thread <key>) finished: ...". A message from outside the agent team has no such line, or says it is from outside the agent team.',
    );
  }

  return lines;
};

/**
 * The situation section's lines.
 */
const situationLines = (facts: BriefingFacts): string[] => {
  const lines = [`You are ${facts.agent}, on thread \`${facts.thread}\`.`];
  const { starter, opener } = facts;
  const handler = facts.loop === "handler";
  const toolsSayWhoReads = facts.tools.contexts.length > 0;

  if (opener?.start && opener.kind === "agent") {
    lines.push(
      handler
        ? `${party(opener)} started you and is waiting for your result. Your code decides what that result is.`
        : `${party(opener)} started you. When you finish, your last text goes to it as your result, so don't send your result any other way.`,
    );
  } else if (opener?.start) {
    lines.push(
      handler
        ? `${party(opener)} started this thread and is waiting for its result. Your code decides what that result is.`
        : `${party(opener)} started this thread and is waiting for its result. When you finish, your last text is that result.`,
    );
  } else {
    if (starter) {
      lines.push(`${party(starter)} started this thread.`);
    }

    if (opener) {
      lines.push(
        handler
          ? `This run was opened by a message from ${party(opener)}. Your code decides what the run's result is.`
          : `This run was opened by a message from ${party(opener)}. When you end a turn, your last text becomes the run's output.`,
      );
    } else if (handler) {
      lines.push(
        `${starter ? "This run was opened by a message from outside the agent team." : "Nothing in the agent team started this thread; its messages come from outside."} Your code decides what the run's result is.`,
      );
    } else {
      lines.push(
        `${starter ? "This run was opened by a message from outside the agent team." : "Nothing in the agent team started this thread; its messages come from outside."} When you end a turn, your last text is saved in the thread and becomes the run's output.${toolsSayWhoReads ? "" : " Whether a person reads it is up to the app that sent the message."}`,
      );
    }
  }

  for (const report of facts.reports) {
    const to =
      report.to.length > 0
        ? report.to.join(" and ")
        : "no one (no destination was given)";
    const data =
      report.schema === undefined
        ? ""
        : `, with data ${shapeOf(report.schema)}`;

    lines.push(
      `You owe ${to} reports of type "${report.type}" (${report.required ? "required" : "optional"})${data}. Send one whenever you have something to report; you may send several.`,
    );
  }

  if (starter?.kind === "agent") {
    lines.push(
      `Messages from ${starter.address} say so. A message marked "from outside the agent team" is from someone else, such as a person steering you.`,
    );
  }

  if (!handler) {
    const children = has(facts, "start_agent");

    lines.push(
      children
        ? "This run ends when you finish a turn with nothing unread, unless agents you started are still working: then it stays open for their results. A message after that starts a new run of this thread, with your history."
        : "This run ends when you finish a turn with nothing unread. A message after that starts a new run of this thread, with your history.",
    );
  }

  if (facts.depth !== undefined && has(facts, "start_agent")) {
    if (facts.depth < 1) {
      lines.push("You can't start agents (depth limit).");
    } else if (facts.depth === 1) {
      lines.push("Agents you start can't start agents of their own.");
    } else if (facts.depth < 4) {
      const more = facts.depth - 1;

      lines.push(
        `Agents you start can start agents of their own, ${more} more level${more === 1 ? "" : "s"} deep.`,
      );
    }
  }

  if (facts.tools.contexts.length > 0) {
    lines.push(
      "From your tools:",
      ...facts.tools.contexts.map(({ tool, context }) => {
        return `- ${tool}: ${context}`;
      }),
    );
  }

  return lines;
};

/**
 * EXPERIMENTAL: the default briefing for `facts`: its text and its sections.
 * Use it in a custom loop to give the model the same briefing the SDK's
 * loops give.
 * @param facts What the briefing is made from (see `briefingFacts()`).
 */
export const renderBriefing = (facts: BriefingFacts): Briefing => {
  const sections: BriefingSections = {
    runtime: `<inngest-runtime v="${briefingVersion}">\n${runtimeLines(facts).join("\n")}\n</inngest-runtime>`,
    situation: `<inngest-situation>\n${situationLines(facts).join("\n")}\n</inngest-situation>`,
  };

  return { text: Object.values(sections).join("\n"), sections };
};

/**
 * The facts of the briefing that come from the model's tools.
 */
export const toolFacts = (tools: SandboxTools): BriefingFacts["tools"] => {
  const names = Object.keys(tools);

  return {
    names,
    wait: isTurnEnder(tools.wait),
    contexts: names.flatMap((name) => {
      const entry = tools[name];

      if (
        typeof entry !== "object" ||
        entry === null ||
        entry instanceof McpServer
      ) {
        return [];
      }

      const context = toolContextOf(
        (entry as { description?: unknown }).description,
      );

      return context === undefined ? [] : [{ tool: name, context }];
    }),
  };
};

/**
 * The facts of a run that don't depend on the loop's tools, which the agent
 * function keeps on the run.
 */
export type RunBriefingFacts = Omit<BriefingFacts, "tools">;

const runFacts = new WeakMap<object, RunBriefingFacts>();

/**
 * Keeps the facts of the run `instance` for `briefingFacts()`.
 */
export const registerBriefingFacts = (
  instance: object,
  facts: RunBriefingFacts,
): void => {
  runFacts.set(instance, facts);
};

/**
 * EXPERIMENTAL: the briefing facts of the agent run this is called in, with
 * the tool facts of `tools` (the tools your loop gives the model), or
 * `undefined` outside an agent run. Pass them to `renderBriefing()` to give a
 * custom loop the SDK's briefing.
 *
 * @example
 * ```ts
 * const facts = briefingFacts(tools);
 * const system = facts
 *   ? `${mySystem}\n\n${renderBriefing(facts).text}`
 *   : mySystem;
 * ```
 */
export const briefingFacts = (
  tools: SandboxTools = {},
): BriefingFacts | undefined => {
  const instance = getAsyncCtxSync()?.execution?.instance;
  const found = instance ? runFacts.get(instance) : undefined;

  return found && { ...found, tools: toolFacts(tools) };
};

/**
 * The briefing a model request carries, after the agent's `briefing` option:
 * the default sections, the option's replacement, or `undefined` for none.
 * @param facts The run's facts with its tools.
 * @param option The agent's `briefing` option.
 */
export const briefingParts = (
  facts: BriefingFacts,
  option: BriefingOption | undefined,
): BriefingParts | undefined => {
  const made = renderBriefing(facts);

  if (!option) {
    return made.sections;
  }

  const replaced = option({ ...made, facts });

  return replaced ? { runtime: "", situation: replaced } : undefined;
};

/**
 * The text of the briefing parts, as one block for the end of a system prompt.
 */
export const briefingText = (parts: BriefingParts): string => {
  return [parts.runtime, parts.situation].filter(Boolean).join("\n");
};
