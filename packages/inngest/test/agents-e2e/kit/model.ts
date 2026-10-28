/**
 * @module
 * The scripted model. It needs no API key and answers from a list of steps,
 * so a scenario asserts on the primitives and never on a model.
 */
import {
  agent,
  type AgentModelRequest as Request,
} from "inngest/experimental/agents";

export type ScriptStep =
  | { say: string; when?: (request: Request) => boolean }
  | {
      call: { name: string; input: unknown };
      when?: (request: Request) => boolean;
    };

const lastUser = (request: Request) => {
  const message = [...request.messages].reverse().find((m) => {
    return m.role === "user";
  });

  return message?.role === "user" ? message.content : "";
};

/**
 * A model that plays `steps`. A step with `when` answers the first request it
 * matches; the others answer by turn, the first one on turn 1, the second on
 * turn 2, and so on. After the script it echoes the last user message.
 * `{{last}}` in a `say` is replaced by that message.
 */
export const script = (steps: ScriptStep[] = []) => {
  return agent.model(async (request) => {
    const matched = steps.find((step) => {
      return step.when?.(request);
    });
    const byTurn = steps.filter((step) => {
      return !step.when;
    })[request.turn - 1];
    const step = matched ?? byTurn ?? { say: "echo: {{last}}" };

    if ("call" in step) {
      const call = {
        id: `call-${request.turn}-${step.call.name}`,
        name: step.call.name,
        input: step.call.input,
      };

      return {
        message: {
          role: "assistant" as const,
          content: [{ type: "tool_use", ...call }],
        },
        toolCalls: [call],
        usage: { input: 10, output: 5 },
      };
    }

    const text = step.say.replaceAll("{{last}}", lastUser(request));

    return {
      message: {
        role: "assistant" as const,
        content: [{ type: "text", text }],
      },
      text,
      toolCalls: [],
      usage: { input: 10, output: 5 },
    };
  });
};
