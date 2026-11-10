/**
 * @module
 * EXPERIMENTAL: the model's inbox tools as the agent run gets them.
 */

import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type {
  AgentFunctionConfig,
  InboxSource,
  OpenedInbox,
  StepWithSubscribe,
} from "../agent/types.ts";
import { createListenTools } from "./inboxTools.ts";
import type { Reader } from "./threadInbox.ts";
import { eventNameOf, inboxFilter } from "./threadInbox.ts";

/**
 * The model's `inbox_listen` and `inbox_close`, or none when the config's
 * `listen` is empty. An inbox the model opens is tied to the thread by the
 * agent's `thread` expression, when it has one, and read through its own view.
 */
export const createBodyInboxTools = (options: {
  config: AgentFunctionConfig;
  view: (source: Inbox<UntypedInboxMessage>) => Reader<UntypedInboxMessage>;
  named: Map<string, OpenedInbox>;
  noteSource: (source: InboxSource) => void;
  // `step.subscribe()` is called below. `subscribe` only types once
  // `inboxMiddleware()` is registered (see `StepWithSubscribe`), which
  // `createAgents` always does - but this parameter's real type comes from
  // the caller's `ctx.step`, not from the ambient ready-made singleton, so
  // the widened type is what names the shape here.
  step: StepWithSubscribe;
  thread: string;
}) => {
  const { config, view, named, noteSource, step, thread } = options;

  if (!config.listen || config.listen.length === 0) {
    return {};
  }

  return createListenTools(
    {
      open: async (as, event, narrow) => {
        // `thread` is written over `event`, the arriving event, and `if` over
        // `async`.
        const given: InboxSource = {
          event,
          ...(config.thread !== undefined && { thread: config.thread }),
          ...(narrow.if !== undefined && { if: narrow.if }),
        } as InboxSource;

        if (config.thread === undefined && narrow.if === undefined) {
          throw new Error(
            `Give "match": this agent has no thread expression, so ${event.name} could not be tied to this thread without it.`,
          );
        }

        noteSource(given);

        const filter = inboxFilter(given, thread);
        const opened = step.subscribe(`inbox:${as}`, {
          event: eventNameOf(event),
          if: filter,
        });

        await inboxOpenedPromise(opened);

        const mine = view(opened as unknown as Inbox<UntypedInboxMessage>);

        named.set(as, {
          as,
          source: { event: eventNameOf(event), if: filter },
          inbox: mine as unknown as Inbox<UntypedInboxMessage>,
        });

        return {
          close: async () => {
            named.delete(as);

            return mine.close();
          },
        };
      },
    },
    config.listen,
  );
};
