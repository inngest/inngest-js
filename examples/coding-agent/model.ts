import Anthropic from "@anthropic-ai/sdk";
import { NonRetriableError } from "inngest";
import { agent } from "inngest/experimental";

const anthropic = new Anthropic();

export const claude = agent.model(async ({ system, messages, tools }) => {
  try {
    const reply = await anthropic.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 8192,
      system,
      tools,
      messages: messages.map((message) => {
        if (message.role !== "tool") {
          return message as Anthropic.MessageParam;
        }

        return {
          role: "user",
          content: message.results.map((result) => {
            return {
              type: "tool_result" as const,
              tool_use_id: result.toolCallId,
              content: result.content,
              is_error: result.isError,
            };
          }),
        };
      }),
    });

    const toolCalls = reply.content.filter((block) => {
      return block.type === "tool_use";
    });
    const text = reply.content.flatMap((block) => {
      return block.type === "text" ? [block.text] : [];
    });

    return {
      message: { role: "assistant", content: reply.content },
      text: text.join("\n"),
      toolCalls,
      done: reply.stop_reason !== "tool_use",
      usage: {
        input: reply.usage.input_tokens,
        output: reply.usage.output_tokens,
      },
    };
  } catch (error) {
    if (error instanceof Anthropic.APIError && error.status === 400) {
      throw new NonRetriableError(error.message);
    }

    throw error;
  }
});
