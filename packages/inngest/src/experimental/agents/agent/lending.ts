/**
 * @module
 * EXPERIMENTAL: what a parent lends a child it starts, and how long the child
 * lives. Only addressable things cross a run boundary: a sandbox's ID, its
 * directory and the names of the built-in tools lent on it. The child opens
 * the machine by that ID and runs the tools as steps of its own run.
 *
 * A child that borrows is attached to its parent's run: the parent's final end
 * sends one `agent/parent.ended` event, which cancels every attached child.
 */

import { createDefer } from "../../../components/DeferredFunction.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import type { SandboxTools } from "../../../components/sandbox/tools.ts";
import { agentParentEnded } from "../inbox/events.ts";
import {
  type AgentSandbox,
  type LentMachine,
  lendableSandbox,
  lendableTool,
} from "../sandboxes/defs.ts";
import { lentIsSigned } from "./relations.ts";

/**
 * What a start lends and how long the child lives: the part of the start
 * options that is not the thread.
 */
export interface LendOptions {
  /**
   * EXPERIMENTAL: Tools of the parent's sandboxes to lend, such as
   * `sandboxes.work.tools`. The child's model gets them and its run executes
   * them as steps against the parent's machine.
   */
  tools?: SandboxTools;

  /**
   * EXPERIMENTAL: Sandboxes of the parent to lend, by the name the child sees
   * them under, such as `{ work: sandboxes.work }`. The child's code gets the
   * machine as `sandboxes.work`. The child never creates, recycles or
   * destroys it.
   */
  sandboxes?: Record<string, AgentSandbox>;

  /**
   * EXPERIMENTAL: Whether the child is tied to the parent's run: it is
   * cancelled when the parent's run ends for good (completed, failed after
   * its retries, or cancelled). Default `true` for a child that borrows lent
   * `tools` or `sandboxes`, and `false` for one that borrows nothing, which
   * lives on its own. `false` with lending is an error.
   */
  attach?: boolean;
}

/**
 * A lend, checked and ready to open: the sandboxes it names, not yet opened.
 */
export interface LendPlan {
  /**
   * Opens each lent sandbox (a step the first time) and gives what the child
   * needs, by name.
   */
  open(): Promise<Record<string, LentMachine>>;
}

/**
 * Checks what a start lends. Throws, before anything is sent, for a tool or
 * sandbox that cannot be lent. Returns `undefined` when nothing is lent.
 * @param options The start's lending options.
 */
export const planLend = (options: LendOptions): LendPlan | undefined => {
  const tools = Object.entries(options.tools ?? {});
  const sandboxes = Object.entries(options.sandboxes ?? {});

  if (tools.length === 0 && sandboxes.length === 0) {
    return undefined;
  }

  // The sandbox each lent name stands for, with the tools lent on it.
  const lent = new Map<
    string,
    {
      lazy: NonNullable<ReturnType<typeof lendableSandbox>>;
      code: boolean;
      tools: LentMachine["tools"];
    }
  >();

  for (const [name, value] of sandboxes) {
    const lazy = lendableSandbox(value);

    if (!lazy) {
      throw new Error(
        `sandboxes.${name} is not a sandbox of this run: lend an entry of the handler's \`sandboxes\``,
      );
    }

    lent.set(lazy.name, { lazy, code: true, tools: [] });
  }

  for (const [name, value] of tools) {
    const origin = lendableTool(value);

    if (!origin) {
      throw new Error(
        `The tool "${name}" is not a tool of a sandbox, so it can't be lent: lend the tools of a sandbox, such as \`sandboxes.work.tools\``,
      );
    }

    // Management, such as the push (made by the lender's host with its
    // token), is never lent.
    if (origin.never) {
      continue;
    }

    if (!origin.builtin) {
      throw new Error(
        `The tool "${name}" is not a built-in sandbox tool (run, read, edit, write, search, runCode), or it was configured with .with(), so it can't be lent`,
      );
    }

    const held = lent.get(origin.lazy.name) ?? {
      lazy: origin.lazy,
      code: false,
      tools: [],
    };

    held.tools.push({ name, builtin: origin.builtin });
    lent.set(origin.lazy.name, held);
  }

  return {
    open: async () => {
      const opened: Record<string, LentMachine> = {};

      for (const [name, held] of lent) {
        const machine = await held.lazy.get();

        opened[name] = {
          id: machine.id,
          cwd: held.lazy.cwd,
          code: held.code,
          tools: held.tools,
        };
      }

      return opened;
    },
  };
};

/**
 * The function that sends `agent/parent.ended`, by client.
 */
const parentEndedFunctions = new WeakMap<
  object,
  ReturnType<typeof createDefer>
>();

/**
 * EXPERIMENTAL: The defer that sends `agent/parent.ended`. A run schedules it
 * when it starts an attached child, and the platform runs it once the run
 * ends for good: completed, failed after its retries, or cancelled; a retry is
 * not an ending. One per app.
 * @param client The app's client.
 */
export const parentEndedFunction = (
  client: Inngest.Any,
): ReturnType<typeof createDefer> => {
  const found = parentEndedFunctions.get(client);

  if (found) {
    return found;
  }

  const made = createDefer(
    client,
    { id: "agents-parent-ended", retries: 3 },
    async ({ event, step }) => {
      await step.sendEvent(
        "parent-ended",
        agentParentEnded.create({ run_id: String(event.data.run_id) }),
      );
    },
  );

  parentEndedFunctions.set(client, made);

  return made;
};

/**
 * The machines a run was lent, from its start event. A lend that is unsigned,
 * or whose signature does not match its parent run and this thread, is
 * refused: the run fails for good, since a forged lend would otherwise name
 * any sandbox.
 * @param client The app's client, whose signing key checks the signature.
 * @param event The event that started the run.
 * @param thread The run's thread key.
 */
export const lentOf = (
  client: Inngest.Any,
  event: { data?: unknown },
  thread: string,
): Record<string, LentMachine> | undefined => {
  const from = (
    event.data as
      | {
          from?: {
            lent?: Record<string, LentMachine>;
            lent_sig?: unknown;
            parent_run?: unknown;
          };
        }
      | undefined
  )?.from;

  if (!from?.lent) {
    return undefined;
  }

  if (
    !lentIsSigned(client, from.lent, from.lent_sig, from.parent_run, thread)
  ) {
    throw new NonRetriableError(
      "The sandboxes lent to this run are unsigned or do not match: only a run of this app can lend",
    );
  }

  return from.lent;
};

/**
 * The `cancelOn` entry every agent has: the `agent/parent.ended` of the run
 * that started it attached. A run nothing attached never matches it.
 */
export const parentEndedCancel = {
  event: agentParentEnded.name,
  if: "event.data.run_id == async.data.from.parent_run",
};
