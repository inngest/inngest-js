/**
 * @module
 * EXPERIMENTAL: the tools an agent's card lists, by the names its model sees.
 */

import {
  type SourceLocation,
  toolSourceOf,
} from "../../../components/sandbox/callSite.ts";
import { builtinTools } from "../../../components/sandbox/codeTools.ts";
import { McpServer } from "../../../components/sandbox/mcp.ts";
import type { SandboxTools } from "../../../components/sandbox/tools.ts";

/**
 * EXPERIMENTAL: a tool on an agent's card.
 */
export interface AgentCardTool {
  /**
   * The name the model sees, such as `getOrg` or `lab_run`.
   */
  name: string;

  /**
   * What the tool does, as the model reads it.
   */
  description?: string;

  /**
   * EXPERIMENTAL: where the tool was defined. Only in dev mode.
   */
  source?: SourceLocation;
}

const entryOf = (name: string, entry: unknown): AgentCardTool | undefined => {
  // An MCP server's tools are known once it is connected, not at definition.
  if (entry instanceof McpServer) {
    return undefined;
  }

  const description = (entry as { description?: unknown } | undefined)
    ?.description;
  const source = toolSourceOf(entry);

  return {
    name,
    ...(typeof description === "string" && { description }),
    ...(source && { source }),
  };
};

/**
 * The tools an agent's definition names, as its card lists them: the `tools`
 * record and each sandbox's tools as `<sandbox>_<tool>`. A `tools` or
 * `sandboxes` that is a function of the run is not known at definition time
 * and lists nothing. Never throws.
 */
export const cardToolsOf = (config: {
  tools?: unknown;
  sandboxes?: unknown;
}): AgentCardTool[] => {
  const found: AgentCardTool[] = [];

  try {
    if (typeof config.tools === "object" && config.tools !== null) {
      for (const [name, entry] of Object.entries(config.tools)) {
        const made = entryOf(name, entry);

        if (made) {
          found.push(made);
        }
      }
    }

    if (typeof config.sandboxes === "object" && config.sandboxes !== null) {
      for (const [sandboxName, value] of Object.entries(config.sandboxes)) {
        const binding = value as {
          sandbox?: { tools?: SandboxTools; model?: boolean };
          tools?: SandboxTools;
          model?: boolean;
        };
        const definition = binding.sandbox ?? binding;
        const model = binding.model ?? definition.model;

        if (model === false) {
          continue;
        }

        const brought = definition.tools ?? builtinTools.defaults;

        for (const [key, entry] of Object.entries(brought)) {
          const made = entryOf(`${sandboxName}_${key}`, entry);

          if (made) {
            found.push(made);
          }
        }
      }
    }
  } catch {
    // A card without tools is fine.
  }

  return found;
};
