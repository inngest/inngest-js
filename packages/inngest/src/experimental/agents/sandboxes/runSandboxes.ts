/**
 * @module
 * EXPERIMENTAL: the sandboxes of one agent run: opened from the config, owned
 * by the thread, and closed together when the body is done.
 */

import type { createDefer } from "../../../components/DeferredFunction.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { step } from "../../../components/InngestStepTools.ts";
import type { Logger } from "../../../middleware/logger.ts";
import type { Context } from "../../../types.ts";
import type { RunFieldContext } from "../agent/runField.ts";
import type { AgentFunctionConfig } from "../agent/types.ts";
import type { Kv } from "../kv/kv.ts";
import type { Skill } from "../skills/skills.ts";
import type { TriggerEvent } from "../threads/thread.ts";
import {
  type LentMachine,
  openSandboxes,
  resolveSandboxes,
  type SandboxRuntime,
  stepSandboxes,
} from "./defs.ts";
import { threadSandboxOwner } from "./threadSandboxes.ts";

/**
 * Opens the sandboxes of an agent for one run, and gives back the function that
 * closes them all.
 */
export const openRunSandboxes = async (options: {
  config: AgentFunctionConfig;
  client: Inngest.Any;
  ref: string;
  context: RunFieldContext<TriggerEvent>;
  thread: string;
  runId: string;
  store: Kv;
  step: typeof step;
  logger: Logger;
  defer: Context.Any["defer"];
  cleanup: ReturnType<typeof createDefer>;

  /**
   * The run's skills; their files go to the first sandbox the model can use.
   */
  skills?: readonly Skill[];

  /**
   * Machines the run's parent lent, by name: adopted by ID, never created or
   * destroyed here.
   */
  lent?: Record<string, LentMachine>;
}) => {
  const { config, client, ref, thread, runId, store, logger, defer, cleanup } =
    options;
  const context = options.context;
  const step = options.step;

  const bindings = await resolveSandboxes(config.sandboxes, context);
  const opened =
    Object.keys(bindings).length > 0 ||
    Object.keys(options.lent ?? {}).length > 0
      ? openSandboxes(
          bindings,
          stepSandboxes(step),
          {
            event: context.event as SandboxRuntime["event"],
            run: (id, fn) => {
              return step.run(id, fn) as ReturnType<typeof fn>;
            },
            // A run that ends without closing a sandbox (cancelled, or failed
            // for good) still has it destroyed. A defer ID is used once per
            // run, so a recycled sandbox's cleanup has its own.
            guard: (name, sandbox, epoch) => {
              const suffix = epoch > 0 ? `:g${epoch}` : "";

              return defer(`${name}:run:cleanup${suffix}`, {
                function: cleanup,
                data: { runId, sandbox: { name, sandboxId: sandbox.id } },
              });
            },
          },
          threadSandboxOwner({
            client: client as unknown as Parameters<
              typeof threadSandboxOwner
            >[0]["client"],
            ref,
            thread: thread,
            runId,
            scope: store.thread,
            warn: (data, message) => {
              logger.warn(data, message);
            },
            run: (id, fn) => {
              return step.run(id, fn) as ReturnType<typeof fn>;
            },
            defer: (id, sandbox) => {
              return defer(id, {
                function: cleanup,
                data: { runId, thread: thread, sandbox },
              });
            },
          }),
          undefined,
          options.lent,
        )
      : {};

  // Machines lent for their tools only: the model's, not the handler's code.
  const toolsOnly = new Set(
    Object.entries(options.lent ?? {})
      .filter(([, machine]) => {
        return !machine.code;
      })
      .map(([name]) => {
        return name;
      }),
  );

  // Closes every sandbox. Returns the first failure instead of throwing, so
  // a failed eager start nothing used never replaces the body's own error.
  const closeAll = async () => {
    const closed = await Promise.allSettled(
      Object.values(opened).map((handle) => {
        return handle.close();
      }),
    );

    return closed.find((outcome) => {
      return outcome.status === "rejected";
    });
  };

  return { opened, closeAll, toolsOnly };
};
