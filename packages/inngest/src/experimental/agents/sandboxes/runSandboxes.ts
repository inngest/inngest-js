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
import type {
  AgentConfigContext,
  AgentFunctionConfig,
} from "../agent/types.ts";
import type { kvFrom } from "../kv/kv.ts";
import { openSandboxes, resolveSandboxes, stepSandboxes } from "./defs.ts";
import { threadSandboxOwner } from "./threadSandboxes.ts";

/**
 * Opens the sandboxes of an agent for one run, and gives back the function that
 * closes them all.
 */
export const openRunSandboxes = async (options: {
  config: AgentFunctionConfig;
  client: Inngest.Any;
  ref: string;
  event: { name: string; data?: unknown };
  thread: string;
  runId: string;
  store: ReturnType<typeof kvFrom>;
  step: typeof step;
  logger: Logger;
  defer: Context.Any["defer"];
  cleanup: ReturnType<typeof createDefer>;
}) => {
  const { config, client, ref, thread, runId, store, logger, defer, cleanup } =
    options;
  const event = options.event;
  const step = options.step;

  const bindings = await resolveSandboxes(config.sandboxes, {
    event: event as unknown as AgentConfigContext["event"],
  });
  const opened =
    Object.keys(bindings).length > 0
      ? openSandboxes(
          bindings,
          stepSandboxes(step),
          {
            event: event as unknown as AgentConfigContext["event"],
            run: (id, fn) => {
              return step.run(id, fn) as ReturnType<typeof fn>;
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
        )
      : {};

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

  return { opened, closeAll };
};
