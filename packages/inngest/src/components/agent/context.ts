/**
 * @module
 * Keeps a long conversation inside the model's context window by summarising
 * its start once, near the limit, on the loop's neutral messages so no
 * provider format is involved. Until then the conversation is sent whole, so
 * a provider's prompt cache keeps hitting the same prefix.
 */
import type { AgentMessage, AgentUsage } from "./loop.ts";

/**
 * A summary of the start of a conversation. The first `upTo` messages are
 * replaced by `summary` whenever the conversation is sent.
 */
export interface AgentCompaction {
  /**
   * How many messages at the start of the conversation the summary replaces.
   */
  upTo: number;

  /**
   * What the summary says.
   */
  summary: string;
}

/**
 * Options for summarising a long conversation.
 */
export interface AgentCompactionOptions {
  /**
   * Summarise once the conversation is estimated to pass this many tokens.
   * Set it well inside the model's context window, since the estimate is
   * rough (about three characters a token).
   */
  maxTokens: number;

  /**
   * How many messages at the end of the conversation are always sent whole.
   * Default 8.
   */
  keep?: number;

  /**
   * Writes the summary. Default: the loop's own `model`, asked for a summary
   * with no tools, whose tokens count in the turn's `usage`.
   */
  summarise?: (input: {
    /**
     * The messages being replaced by the summary.
     */
    messages: AgentMessage[];

    /**
     * The summary made before, which these messages come after.
     */
    previous?: string;
  }) => Promise<string>;
}

/**
 * Calls the loop's model for a summary: the system prompt and one user
 * message, no tools.
 */
export type Summariser = (
  system: string,
  prompt: string,
) => Promise<{ text: string; usage?: AgentUsage }>;

const defaultKeep = 8;

const summaryPrompt =
  "You compact the earlier part of a conversation between a user and an assistant that works with tools, so the conversation can go on in a smaller space. Write what the assistant needs to continue as if nothing was lost: what was asked, every decision and why, every file, path, id, URL and command and its outcome that may matter again, what is done, what is half done, what failed, and what is still open. Keep exact values and names. Do not add opinions. Plain text, no preamble.";

const maxTranscriptResult = 20_000;

const transcriptOf = (messages: AgentMessage[]): string => {
  return messages
    .map((message) => {
      if (message.role === "tool") {
        return message.results
          .map((result) => {
            const body =
              result.content.length > maxTranscriptResult
                ? `${result.content.slice(0, maxTranscriptResult / 2)}\n[... ${result.content.length - maxTranscriptResult} characters ...]\n${result.content.slice(-maxTranscriptResult / 2)}`
                : result.content;

            return `[result of ${result.name} ${JSON.stringify(result.input)}${result.isError ? ", failed" : ""}]\n${body}`;
          })
          .join("\n");
      }

      const text =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);

      return `${message.role}: ${text}`;
    })
    .join("\n\n");
};

/**
 * A rough token count: about three characters a token, counted on the JSON of
 * the messages.
 */
export const estimateTokens = (messages: AgentMessage[]): number => {
  return Math.ceil(JSON.stringify(messages).length / 3);
};

/**
 * The messages as they are sent: everything after the compaction's `upTo`,
 * behind one user message that holds its summary. Without a compaction, the
 * messages themselves.
 */
export const compactedView = (
  messages: AgentMessage[],
  compaction: AgentCompaction | undefined,
): AgentMessage[] => {
  if (!compaction || compaction.upTo > messages.length) {
    return messages;
  }

  return [
    {
      role: "user",
      content: `[system] The start of this conversation, summarised to save space:\n${compaction.summary}`,
    },
    ...messages.slice(compaction.upTo),
  ];
};

/**
 * Returns the messages to send. Under the budget that is the conversation
 * whole (behind the summary made before, if any). Over it, everything but the
 * last `keep` messages is summarised into a new compaction, returned as
 * `made` so the caller can store it. The cut never lands on a tool message,
 * since those only make sense after the reply that asked for them.
 */
export const withCompaction = async (input: {
  messages: AgentMessage[];
  held: AgentCompaction | undefined;
  options: AgentCompactionOptions;
  summarise: Summariser;
}): Promise<{
  messages: AgentMessage[];
  made?: AgentCompaction;
  usage?: AgentUsage;
}> => {
  const { messages, options } = input;
  const held =
    input.held && input.held.upTo <= messages.length ? input.held : undefined;
  const current = compactedView(messages, held);

  if (estimateTokens(current) <= options.maxTokens) {
    return { messages: current };
  }

  const from = held?.upTo ?? 0;
  let cut = messages.length - Math.max(1, options.keep ?? defaultKeep);

  while (cut > from && messages[cut]?.role === "tool") {
    cut -= 1;
  }

  if (cut <= from) {
    return { messages: current };
  }

  const replaced = messages.slice(from, cut);
  let summary: string;
  let usage: AgentUsage | undefined;

  if (options.summarise) {
    summary = await options.summarise({
      messages: replaced,
      ...(held && { previous: held.summary }),
    });
  } else {
    const answer = await input.summarise(
      summaryPrompt,
      `${held ? `Summary so far:\n${held.summary}\n\nThen:\n` : ""}${transcriptOf(replaced)}`,
    );

    summary = answer.text;
    usage = answer.usage;
  }

  // An empty summary would drop the history for nothing.
  if (summary.trim() === "") {
    return { messages: current, ...(usage && { usage }) };
  }

  const made = { upTo: cut, summary };

  return {
    messages: compactedView(messages, made),
    made,
    ...(usage && { usage }),
  };
};
