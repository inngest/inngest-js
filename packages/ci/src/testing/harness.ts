/**
 * What a test of a pipeline starts from: a client on the fake Sandboxes API
 * and a `ci` that reports to the console, with `run` driving one pipeline
 * whose handler a test defines. `drawTrace` draws the trace such a run left.
 *
 * @module
 */

import { version as sdkVersion } from "inngest";
import { consoleReporter } from "../github/auth.ts";
import { createCi } from "../pipeline/createCi.ts";
import { ciOrigin } from "../pipeline/names.ts";
import { createCiTestClient } from "./client.ts";
import { prEvent, prTrigger } from "./events.ts";
import type { CommandScript, FakeSandboxApi } from "./fakeSandbox.ts";
import { createFakeSandboxApi } from "./fakeSandbox.ts";
import { runFunction } from "./runFunction.ts";

export type Ci = ReturnType<typeof createCi>;

export type RunResult = Awaited<ReturnType<typeof runFunction>>;

export const ciTest = (
  options: {
    /** The fake API to run on. Defaults to a fresh one. */
    api?: FakeSandboxApi;
    /** What the commands it runs do. */
    scripts?: CommandScript[];
  } = {},
) => {
  const api = options.api ?? createFakeSandboxApi();

  api.script(options.scripts ?? []);

  const ci = createCi(createCiTestClient(api), { github: consoleReporter() });

  return {
    api,
    ci,
    /** Run the pipeline whose handler `define` makes from `ci`. */
    run: (define: (ci: Ci) => () => Promise<unknown>): Promise<RunResult> => {
      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, define(ci));

      return runFunction(pipeline, { event: prEvent });
    },
  };
};

interface TraceNode {
  label: string;
  children: Map<string, TraceNode>;
}

/**
 * Draw a run's trace as an indented tree, the way the UI nests it: each span
 * once, where its first step is, with its kind in brackets, and each step
 * under its spans.
 */
export const drawTrace = (
  result: RunResult,
  /** Suffix each row with who it says did it, as in `Create sandbox <- ci`. */
  withOrigins = false,
): string => {
  const root: TraceNode = { label: "", children: new Map() };

  const by = (origin: string | undefined) => {
    if (!withOrigins || !origin) {
      return "";
    }

    const names: Record<string, string> = {
      [ciOrigin]: "ci",
      [`inngest@${sdkVersion}`]: "inngest",
    };

    return ` <- ${names[origin] ?? origin}`;
  };

  for (const stepId of result.stepIds) {
    let node = root;

    for (const span of result.spans[stepId] ?? []) {
      const key = `span:${span.id}`;
      const label = span.kind ? `${span.name} [${span.kind}]` : span.name;

      const child = node.children.get(key) ?? {
        label: `${label}${by(span.origin)}`,
        children: new Map(),
      };

      node.children.set(key, child);

      node = child;
    }

    node.children.set(`step:${stepId}`, {
      label: `${result.names[stepId] ?? stepId}${by(result.origins[stepId])}`,
      children: new Map(),
    });
  }

  const lines: string[] = [];

  const draw = (node: TraceNode, depth: number) => {
    for (const child of node.children.values()) {
      lines.push(`${"  ".repeat(depth)}${child.label}`);

      draw(child, depth + 1);
    }
  };

  draw(root, 0);

  return lines.join("\n");
};
