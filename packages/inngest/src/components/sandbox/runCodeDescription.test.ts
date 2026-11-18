/**
 * @module
 * The `runCode` tool tells the model which tools its code can call: the
 * agent's own for this run and the ones given with `with()`, one line each,
 * and which languages it takes.
 */
import { z } from "zod/v4";
import { getAsyncLocalStorage, runWithAsyncCtx } from "../execution/als.ts";
import { builtinTools } from "./codeTools.ts";
import {
  bindSandbox,
  type SandboxTools,
  tool,
  toolDefinitions,
} from "./tools.ts";
import type { SandboxHandle } from "./types.ts";

const { runCode } = builtinTools;

const agentTools: SandboxTools = {
  start_agent: tool({
    description: "Starts an agent on a new thread. It gives the thread key.",
    group: true,
    input: z.object({
      address: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async () => {
      return { thread: "t" };
    },
  }),
};

const describeIn = async (
  codeTools: SandboxTools | undefined,
  tools: SandboxTools,
): Promise<string> => {
  await getAsyncLocalStorage();

  return runWithAsyncCtx(
    {
      app: {} as never,
      execution: { agentBridge: { codeTools } } as never,
    },
    () => {
      const [definition] = toolDefinitions(tools);

      return definition?.description ?? "";
    },
  );
};

describe("the runCode description", () => {
  test("names the languages, with no tools listed when code has none", async () => {
    const text = await describeIn(undefined, { runCode });

    expect(text).toContain('`language` is "python" or "typescript"');
    expect(text).toContain('there is no "javascript"');
    expect(text).not.toContain("Tools your code can call");
  });

  test("lists the agent's tools for this run and the ones given with with(), one line each", async () => {
    const lookup = tool({
      description: "Looks up a customer. Gives their plan.",
      input: z.object({ id: z.string(), full: z.boolean().optional() }),
      run: async () => {
        return { plan: "pro" };
      },
    });
    const text = await describeIn(agentTools, {
      runCode: runCode.with({ tools: { lookup } }),
    });

    expect(text).toContain(
      "- tools.start_agent({ address: string, input?: object }): Starts an agent on a new thread.",
    );
    expect(text).toContain(
      "- tools.lookup({ id: string, full?: boolean }): Looks up a customer.",
    );
  });

  test("the list survives binding the tool to a sandbox", async () => {
    const bound = bindSandbox(runCode, {} as SandboxHandle, "lab");
    const text = await describeIn(agentTools, { runCode: bound });

    expect(text).toContain("- tools.start_agent(");
    expect(text).toContain("Works on the `lab` sandbox.");
  });
});
