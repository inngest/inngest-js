/**
 * @module
 * EXPERIMENTAL: `dryRun()`, which turns a set of tools into ones that are safe
 * to run for real: tools that only read still run, and every other tool
 * answers with what it would have done. The call is still the same step, so a
 * dry run has the shape of a live one.
 */
import {
  type SandboxTool,
  type SandboxTools,
  toTool,
} from "../sandbox/tools.ts";

const simulated = (name: string, definition: SandboxTool): SandboxTool => {
  const { effect = "write", output } = definition;
  const wouldCall = `Would call: ${name}`;

  // Positional tools get their arguments as a list, then the context.
  const simulate = (args: unknown[]): unknown => {
    const input = definition.input ? args[0] : args.slice(0, -1);

    return definition.simulate
      ? (definition.simulate as (input: unknown) => unknown)(input)
      : { dryRun: true, wouldCall: name, args: input };
  };

  if (effect === "read") {
    return definition;
  }

  if (typeof effect === "string") {
    return {
      ...definition,
      group: false,
      displayName: wouldCall,
      output: undefined,
      run: (...args: unknown[]) => {
        return simulate(args);
      },
    } as SandboxTool;
  }

  const reads = (args: unknown[]): boolean => {
    return (effect as (input: unknown) => string)(args[0]) === "read";
  };
  const { displayName } = definition;

  return {
    ...definition,
    displayName: (input: unknown) => {
      if (!reads([input])) {
        return wouldCall;
      }

      return typeof displayName === "function"
        ? (displayName as (input: unknown) => string)(input)
        : (displayName ?? name);
    },
    output: undefined,
    run: async (...args: unknown[]) => {
      if (!reads(args)) {
        return simulate(args);
      }

      const value = await (definition.run as (...a: unknown[]) => unknown)(
        ...args,
      );
      const result = await output?.["~standard"].validate(value);

      if (result?.issues) {
        throw new Error(`${name} returned an invalid result`);
      }

      return result ? result.value : value;
    },
  } as SandboxTool;
};

/**
 * EXPERIMENTAL: The same tools, safe to run without side effects. A tool runs
 * for real only if its `effect` is `"read"`. Any other tool, including one
 * with no `effect`, answers with its `simulate(input)`, or by default
 * `{ dryRun: true, wouldCall: name, args }`, in a step called
 * "Would call: name".
 *
 * Use it for tools passed to `agent.loop({ dryRun })` (which does this for
 * you) and for tools given to code in a sandbox. A tool with a function for
 * its `effect` that is a group of steps runs no steps when it is simulated.
 *
 * @example
 * ```ts
 * await sandbox.commands.run("analyse", "python3 analyse.py", {
 *   tools: dryRun({ getOrder, refund }),
 * });
 * ```
 */
export const dryRun = (tools: SandboxTools): SandboxTools => {
  return Object.fromEntries(
    Object.entries(tools).map(([name, entry]) => {
      return [name, simulated(name, toTool(entry))];
    }),
  );
};
