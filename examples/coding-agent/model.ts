import Anthropic from "@anthropic-ai/sdk";
import { agent } from "inngest/experimental/agents";

export const claude = agent.anthropic({
  model: "claude-sonnet-5-5",
  client: new Anthropic(),
  maxTokens: 8192,
});
