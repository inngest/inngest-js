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
import { agentRecoverEvent } from "../threads/thread.ts";
import { type Grant, lendDigest } from "./grant.ts";
import { ledgerDataIsSigned } from "./relations.ts";

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
 * What a run's start event lends it, checked for its signature but not yet for
 * whether the thread may still use it.
 */
export interface LendClaim {
  /**
   * The lent machines, by name.
   */
  machines: Record<string, LentMachine>;

  /**
   * The parent run that lent them.
   */
  parentRun: string;

  /**
   * Whether the lend came on a resend made by `recovery`, not on the start
   * message itself.
   */
  recovered: boolean;
}

/**
 * The `from` a start event carries: on the message itself, or inside the
 * message a recovery resent.
 */
const startFrom = (event: {
  name?: string;
  data?: unknown;
}): { from: Record<string, unknown> | undefined; recovered: boolean } => {
  if (event.name === agentRecoverEvent) {
    const resent = (
      event.data as { event?: { data?: { from?: Record<string, unknown> } } }
    )?.event;

    return { from: resent?.data?.from, recovered: true };
  }

  return {
    from: (event.data as { from?: Record<string, unknown> } | undefined)?.from,
    recovered: false,
  };
};

/**
 * The lend a run's start event carries, with its signature checked. A lend
 * that is unsigned, or whose signature does not match its parent run and this
 * thread, is refused: the run fails for good, since a forged lend would
 * otherwise name any sandbox. A lend on a recovery's resend must also come on
 * a resend this app signed.
 *
 * Whether the thread may use it is `lendIsOpen`.
 * @param client The app's client, whose signing key checks the signatures.
 * @param event The event that started the run.
 * @param thread The run's thread key.
 * @param grant The grant the start carried, verified: it must be issued by this app, and names the lend by
 * digest and the parent run that lends.
 */
export const lendOf = (
  client: Inngest.Any,
  event: { name?: string; data?: unknown },
  thread: string,
  grant?: Grant,
): LendClaim | undefined => {
  const { from, recovered } = startFrom(event);
  const lent = from?.lent as Record<string, LentMachine> | undefined;

  if (!lent) {
    return undefined;
  }

  if (
    grant?.sub !== thread ||
    grant.iss !== client.id ||
    grant.run === undefined ||
    grant.lend !== lendDigest(lent) ||
    (recovered && !ledgerDataIsSigned(client, agentRecoverEvent, event.data))
  ) {
    throw new NonRetriableError(
      "The sandboxes lent to this run are unsigned or do not match: only a run of this app can lend",
    );
  }

  return { machines: lent, parentRun: grant.run, recovered };
};

/**
 * What a thread's record keeps of the lend it took.
 */
export interface LentRecord {
  parentRun: string;

  /**
   * The names of the tools lent, so a later run can tell the model they are
   * gone.
   */
  tools: string[];

  /**
   * The run that took the lend first.
   */
  takenBy: string;
}

/**
 * Whether the thread may use a lend that checked out. A lend is not dated: it
 * lasts as long as the parent's run, whose end cancels the child. What keeps
 * a copied start event from borrowing the machine again is the thread's own
 * record, which keeps the lend the first run took:
 *
 * - the message that started the thread opens the lend once: the run that
 *   first took it is the only run of that message that may use it;
 * - a recovery's resend on that same thread may use it again, since the failed
 *   run was the one that took it. The lend names the thread and the parent
 *   run, and the resend is signed by this app.
 *
 * Any other message, or a copy of the start event, gets no lend.
 * @param claim What the start event lends.
 * @param kept What the thread's record kept, after this run noted its start.
 * @param runId This run.
 */
export const lendIsOpen = (
  claim: LendClaim,
  kept: LentRecord | undefined,
  runId: string,
): boolean => {
  return (
    kept?.parentRun === claim.parentRun &&
    (claim.recovered || kept.takenBy === runId)
  );
};

/**
 * The names of the tools a lend gives.
 */
export const lentToolNames = (
  machines: Record<string, LentMachine>,
): string[] => {
  return Object.values(machines).flatMap((machine) => {
    return machine.tools.map((given) => {
      return given.name;
    });
  });
};

/**
 * What the model of a run that borrowed before reads, once the lend is over:
 * the lent tools ended with the start of the parent's run.
 * @param tools The names of the tools that were lent.
 */
export const lentEndedNote = (tools: string[]): string => {
  return `The tools your parent lent you${tools.length > 0 ? ` (${tools.join(", ")})` : ""} were available only for the work your parent started you with. They ended with that start and are not available now, so do not call them.`;
};

/**
 * The `cancelOn` entry every agent has: the `agent/parent.ended` of the run
 * that started it attached. A run nothing attached never matches it.
 *
 * In `cancelOn`, `event` is the run's own trigger and `async` is the arriving
 * `agent/parent.ended`. The trigger names the parent run, directly or inside
 * the message a recovery resent (so a recovered child ends with its parent
 * too); the arriving event names the run that ended. A trigger without a
 * `parent_run` never matches a real event.
 */
export const parentEndedCancel = {
  event: agentParentEnded.name,
  if: `async.data.run_id == (event.name == "${agentRecoverEvent}" ? event.data.event.data.from.parent_run : event.data.from.parent_run)`,
};
