/**
 * @module
 * The scripted model of the kit, a plain model function. It answers from a
 * list of steps and, when given a recorder, reports the request each call was
 * shown to the fakes server, so a scenario in the CLI process can read what
 * a model running in the app process saw.
 */
import type {
  AgentModel,
  AgentModelRequest as Request,
} from "inngest/experimental/agents";

/**
 * One step of a scripted model: say something, or call a tool.
 */
export type ScriptStep =
  | { say: string; when?: (request: Request) => boolean }
  | {
      call: { name: string; input: unknown };
      when?: (request: Request) => boolean;
    };

/**
 * What a recording model was shown for one call.
 */
export interface ModelCall {
  turn: number;
  system?: string;
  messages: Request["messages"];

  /**
   * The names of the tools the request offered.
   */
  tools: string[];
}

/**
 * Where a model reports the requests it receives: the fakes server's URL and
 * the name the scenario reads them by.
 */
export interface Recorder {
  url: string;
  name: string;
}

const lastUser = (request: Request) => {
  const message = [...request.messages].reverse().find((m) => {
    return m.role === "user";
  });

  if (message?.role !== "user") {
    return "";
  }

  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
};

/**
 * A model that plays `steps`. A step with `when` answers the first request it
 * matches; the others answer by turn, the first one on turn 1, the second on
 * turn 2, and so on. After the script it echoes the last user message.
 * `{{last}}` in a `say` is replaced by that message. With a `recorder`, every
 * call is reported before it is answered.
 */
export const script = (
  steps: ScriptStep[] = [],
  recorder?: Recorder,
): AgentModel => {
  return async (request) => {
    if (recorder) {
      const call: ModelCall = {
        turn: request.turn,
        system: request.system,
        messages: request.messages,
        tools: request.tools.map((tool) => {
          return tool.name;
        }),
      };
      const res = await fetch(
        `${recorder.url}/model/${encodeURIComponent(recorder.name)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(call),
        },
      );

      if (!res.ok) {
        throw new Error(`The recorder refused a model call: ${res.status}`);
      }
    }

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
  };
};
