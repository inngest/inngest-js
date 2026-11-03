/**
 * @module
 * The scripted model `tour:verify` runs pages with: a plain model function
 * that answers from the script in the page's manifest (`verify.model`), so a
 * page that needs a model works with no key and no download, and says the
 * same thing every time. The tour server sets `TOUR_MODEL=scripted` and the
 * script in `TOUR_MODEL_SCRIPT` when verify starts the tour; `models.ts` asks
 * `isScripted()` and returns `scriptedModel()` when it is true.
 */
import type {
  AgentModel,
  AgentModelRequest,
} from "inngest/experimental/agents";

// One turn of the script: say something, or call a tool. A step with `when`
// answers the first request it matches; the others answer by turn.
export type ScriptStep =
  | { say: string; when?: (request: AgentModelRequest) => boolean }
  | {
      call: { name: string; input: unknown };
      when?: (request: AgentModelRequest) => boolean;
    };

export const isScripted = () => {
  return process.env.TOUR_MODEL === "scripted";
};

const lastUser = (request: AgentModelRequest) => {
  const message = [...request.messages].reverse().find((candidate) => {
    return candidate.role === "user";
  });

  if (message?.role !== "user") {
    return "";
  }

  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
};

/**
 * A model that plays `steps`. After the script it echoes the last user
 * message; `{{last}}` in a `say` is replaced by that message.
 */
export const script = (steps: ScriptStep[] = []): AgentModel => {
  return async (request) => {
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
          content: [{ type: "tool_use" as const, ...call }],
        },
        toolCalls: [call],
        usage: { input: 10, output: 5 },
      };
    }

    const text = step.say.replaceAll("{{last}}", lastUser(request));

    return {
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
      },
      text,
      toolCalls: [],
      usage: { input: 10, output: 5 },
    };
  };
};

export const scriptedModel = () => {
  return script(
    JSON.parse(process.env.TOUR_MODEL_SCRIPT ?? "[]") as ScriptStep[],
  );
};
