import {
  createAgent,
  createNetwork,
  createRoutingAgent,
  createTool,
  openai,
  State,
} from "@inngest/agent-kit";
import { z } from "zod";
import { isLastMessageOfType, lastResult } from "./utils";
import { navigate, extract, act, observe } from "./stagehand-tools";


const webSearchAgent = createAgent({
  name: "web_search_agent",
  description: "I am a web search agent.",
  system: `You are a web search agent.
  `,
  tools: [navigate, extract, act, observe],
});

const supervisorRoutingAgent = createRoutingAgent({
  name: "Supervisor",
  description: "I am a Research supervisor.",
  system: `You are a research supervisor.
Your goal is to search for information linked to the user request by augmenting your own research with the "web_search_agent" agent.

Think step by step and reason through your decision.

When the answer is found, call the "done" agent.`,
  model: openai({
    model: "gpt-4o",
  }),
  tools: [
    createTool({
      name: "route_to_agent",
      description: "Invoke an agent to perform a task",
      parameters: z.object({
        agent: z.string().describe("The agent to invoke"),
      }),
      handler: async ({ agent }) => {
        return agent;
      },
    }),
  ],
  tool_choice: "route_to_agent",
  lifecycle: {
    onRoute: ({ result, network }) => {
      const lastMessage = lastResult(network?.state.results);

      // ensure to loop back to the last executing agent if a tool has been called
      if (lastMessage && isLastMessageOfType(lastMessage, "tool_call")) {
        return [lastMessage?.agent.name];
      }

      const tool = result.toolCalls[0];
      if (!tool) {
        return;
      }
      const toolName = tool.tool.name;
      if (toolName === "done") {
        return;
      } else if (toolName === "route_to_agent") {
        if (
          typeof tool.content === "object" &&
          tool.content !== null &&
          "data" in tool.content &&
          typeof tool.content.data === "string"
        ) {
          return [tool.content.data];
        }
      }
      return;
    },
  },
});

// Create a network with the agents and default router
export const searchNetwork = createNetwork({
  name: "Simple Search Network",
  agents: [webSearchAgent],
  maxIter: 15,
  defaultModel: openai({
    model: "gpt-4o",
  }),
  defaultRouter: supervisorRoutingAgent,
});

