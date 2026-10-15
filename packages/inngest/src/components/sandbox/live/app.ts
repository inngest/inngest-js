/**
 * @module
 * The app of the live sandbox runner suite. One function runs every case in
 * `cases.ts` against real sandboxes, checks each outcome and returns the
 * verdicts, which `run.ts` prints. See `README.md` in this folder.
 */

import { deepStrictEqual } from "node:assert";
import { createServer } from "node:http";
import { serve } from "../../../node.ts";
import { Inngest } from "../../Inngest.ts";
import { sandboxMiddleware } from "../middleware.ts";
import type { DurableSandbox } from "../types.ts";
import { caseId, cases, type LiveCase, liveTools } from "./cases.ts";

const inngest = new Inngest({
  id: "sandbox-runners-live",
  middleware: [sandboxMiddleware()],
});

interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}

const messageOf = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Why `outcome` isn't what the case expects, or undefined when it is.
 */
const mismatch = (
  { expect }: LiveCase,
  outcome: { value: unknown } | { error: string },
): string | undefined => {
  if (expect instanceof RegExp) {
    if ("value" in outcome) {
      return `expected an error, got ${JSON.stringify(outcome.value)}`;
    }

    return expect.test(outcome.error)
      ? undefined
      : `error didn't match ${expect}: ${outcome.error.slice(0, 300)}`;
  }

  if ("error" in outcome) {
    return `unexpected error: ${outcome.error.slice(0, 300)}`;
  }

  try {
    deepStrictEqual(outcome.value, expect);
  } catch (error) {
    return messageOf(error).slice(0, 300);
  }

  return undefined;
};

/**
 * Write a file to the handle, read it back, and read it from user code.
 */
const roundTrip = async (
  handle: DurableSandbox,
): Promise<string | undefined> => {
  const path = "/tmp/live-file.txt";

  try {
    await handle.files.write("file-write", { path, data: "hello" });
    const back = new TextDecoder().decode(
      await handle.files.read("file-read", path),
    );
    const fromCode = await handle.python(
      "file-in-code",
      `return open('${path}').read()`,
    );
    deepStrictEqual([back, fromCode], ["hello", "hello"]);
  } catch (error) {
    return messageOf(error).slice(0, 300);
  }

  return undefined;
};

/**
 * Run the case's code with its language's interpreter, and return the stdout.
 */
const runCommand = async (
  handle: DurableSandbox,
  id: string,
  { language, code }: LiveCase,
  { tools, toolOptions }: { tools?: typeof liveTools; toolOptions?: object },
): Promise<string> => {
  const flag = language === "python" ? ["python3", "-c"] : ["node", "-e"];
  const { stdout } = await handle.commands.run(id, [...flag, code], {
    tools,
    toolOptions,
  });

  return stdout.trim();
};

const live = inngest.createFunction(
  {
    id: "run-live-cases",
    retries: 0,
    triggers: [{ event: "sandbox-runners-live/run" }],
  },
  async ({ event, step, runId }) => {
    const { only = "", dry = false } = event.data as {
      only?: string;
      dry?: boolean;
    };
    const selected = cases.filter((c) => {
      return caseId(c).includes(only);
    });
    if (dry) {
      return selected.map(caseId);
    }

    const verdicts: Verdict[] = [];
    const record = (name: string, problem: string | undefined) => {
      verdicts.push({ name, pass: !problem, detail: problem ?? "" });
    };

    const needsHandle = selected.some((c) => {
      return c.form !== "oneshot";
    });
    const handle = needsHandle
      ? await step.sandbox.create("shared", {
          name: `${runId}-shared`,
          vcpu: 2,
          memoryMb: 2048,
        })
      : undefined;

    for (const c of selected) {
      const options = {
        input: c.input,
        ...(c.schema && { schema: { output: c.schema } }),
        ...(c.tools && {
          tools: liveTools,
          toolOptions: c.tools === true ? {} : c.tools,
        }),
      };
      const id = caseId(c);
      const runner = c.form === "handle" ? handle?.[c.language] : undefined;

      let outcome: { value: unknown } | { error: string };
      try {
        const value =
          c.form === "command"
            ? await runCommand(handle as DurableSandbox, id, c, options)
            : await (runner ?? step.sandbox[c.language])(id, c.code, options);
        outcome = {
          value: c.measure === "length" ? (value as string).length : value,
        };
      } catch (error) {
        outcome = { error: messageOf(error) };
      }

      record(id, mismatch(c, outcome));
    }

    if (handle) {
      record("handle.files.write and read", await roundTrip(handle));
      await handle.destroy("shared:destroy");
    }

    const leaked = await step.run("check-destroyed", async () => {
      const { items } = await inngest.sandboxes.list({ limit: 100 });

      return items
        .filter((s) => {
          return s.name.startsWith(`${runId}-`) && s.status === "RUNNING";
        })
        .map((s) => {
          return s.name;
        });
    });
    record(
      "every sandbox destroyed",
      leaked.length ? `still running: ${leaked.join(", ")}` : undefined,
    );

    return verdicts;
  },
);

const helper = inngest.createFunction(
  { id: "live-helper", triggers: [{ event: "sandbox-runners-live/help" }] },
  async ({ event }) => {
    return { echoed: event.data.id };
  },
);

const handler = serve({ client: inngest, functions: [live, helper] });

createServer((req, res) => {
  return handler(req, res);
}).listen(Number(process.env.PORT), () => {
  console.log(`sandbox-runners-live listening on ${process.env.PORT}`);
});
