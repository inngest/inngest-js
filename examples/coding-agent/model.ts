import Anthropic from "@anthropic-ai/sdk";
import { agent } from "inngest/experimental";

export const claude = agent.anthropic(new Anthropic(), {
  model: "claude-sonnet-5-5",
  max_tokens: 8192,
});
