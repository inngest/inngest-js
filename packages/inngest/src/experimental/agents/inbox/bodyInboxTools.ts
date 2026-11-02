/**
 * @module
 * EXPERIMENTAL: the model's inbox tools as the agent body gets them.
 */

import type { step } from "../../../components/InngestStepTools.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type {
  AgentFunctionConfig,
  InboxSource,
  OpenedInbox,
  ThreadInbox,
} from "../agent/types.ts";
import { toAsync } from "../cel.ts";
import { createInboxTools } from "./inboxTools.ts";
import type { Reader } from "./threadInbox.ts";
import { eventNameOf, inboxFilter } from "./threadInbox.ts";

/**
 * The model's inbox tools for the body, or none when the config has none. A
 * source the model opens is tied to the thread and read through its own view.
 */
export const createBodyInboxTools = (options: {
  config: AgentFunctionConfig;
  inbox: ThreadInbox;
  view: (source: Inbox<UntypedInboxMessage>) => Reader<UntypedInboxMessage>;
  named: Map<string, OpenedInbox>;
  noteSource: (source: InboxSource) => void;
  step: typeof step;
  thread: string;
}) => {
  const { config, inbox, view, named, noteSource, step, thread } = options;

  return config.inboxTools
    ? createInboxTools(
        {
          handler: inbox,
          open: async (as, event, options) => {
            // The tools write `thread` and `if` over `event`, the
            // arriving event.
            const given: InboxSource = {
              event,
              ...options,
              ...(options.if !== undefined && {
                if: toAsync(options.if),
              }),
            } as InboxSource;

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
              next: (options) => {
                return mine.next(options);
              },
              drain: () => {
                return mine.drain();
              },
              close: async () => {
                named.delete(as);

                return mine.close();
              },
            };
          },
        },
        config.inboxTools,
      )
    : {};
};
