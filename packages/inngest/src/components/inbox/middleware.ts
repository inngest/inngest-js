/**
 * @module
 * The middleware that adds the experimental `step.subscribe()`.
 *
 * The inbox ops, the state a read looks in and the opcodes live in the core
 * module; what this adds is the `subscribe` statement itself, so a run only has
 * it when the app opts in.
 */
import { subscribeCapability } from "../../helpers/consts.ts";
import { timeStr } from "../../helpers/strings.ts";
import type { StepOptions, StepOptionsOrId } from "../../types.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { firstReport, hashedStepId } from "../execution/inboxState.ts";
import { internalLoggerSymbol } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { sdkOrigin } from "../sandbox/trace.ts";
import {
  type Cut,
  Inbox,
  type InboxMessageOf,
  type InboxSources,
  sourcesOf,
} from "./Inbox.ts";

/**
 * The tag every inbox statement carries in a trace, shown beside its row.
 */
export const inboxTag = "\u2709\uFE0F";

/**
 * What the middleware adds to `step`.
 */
type InboxStepExtension = {
  /**
   * EXPERIMENTAL: opens an inbox inside the run. Every event that matches
   * one of the sources and arrives afterwards becomes a message, saved once
   * as its own step whether or not it is read. Read the inbox with `next()`.
   *
   * A source is written like a trigger: an event type (or its name), or an
   * object with the event and an `if` expression, which sees the arriving
   * event as `async`. Pass one source or an array.
   *
   * The inbox's messages are typed from the sources: the union of the shapes
   * of the event types given. A source written as a name has no schema, so
   * its messages stay the default message, whose `data` is `unknown`.
   *
   * @example
   * ```ts
   * await using inbox = step.subscribe("reviews", pr.reviewed);
   * const review = await inbox.next();
   * ```
   */
  subscribe: <const S extends InboxSources>(
    idOrOptions: StepOptionsOrId,

    /**
     * What the inbox receives.
     */
    sources: S,
  ) => Inbox<InboxMessageOf<S>>;
};

/**
 * The options that make an op one part of the inbox statement `statement`.
 * Every op of a statement shares the span, which the trace shows as one group
 * row carrying `inboxTag`, and each has the SDK's origin, so the trace dims it
 * inside that row.
 */
const inboxStatement = (
  statement: string,
  name: string,
  op: string,
): StepOptions => {
  return {
    id: op,
    "~span": { id: statement, name, kind: inboxTag },
    "~origin": sdkOrigin,
  };
};

/**
 * Adds the experimental `step.subscribe()`, which opens an inbox inside a run.
 *
 * The inbox is built from the ops the core module already carries, so this only
 * decides whether a run can write the `subscribe` statement at all.
 */
export class InboxMiddleware extends Middleware.BaseMiddleware {
  readonly id = "inngest:inbox";

  override transformFunctionInput(
    arg: Middleware.TransformFunctionInputArgs,
  ): Middleware.TransformFunctionInputArgs & {
    ctx: Middleware.TransformFunctionInputArgs["ctx"] & {
      step: Middleware.TransformFunctionInputArgs["ctx"]["step"] &
        InboxStepExtension;
    };
  } {
    const { step } = arg.ctx;

    const subscribe = <const S extends InboxSources>(
      idOrOptions: StepOptionsOrId,
      sources: S,
    ): Inbox<InboxMessageOf<S>> => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      const capabilities = getAsyncCtxSync()?.execution?.executorCapabilities;

      if (capabilities && !capabilities.includes(subscribeCapability)) {
        throw new NonRetriableError(
          "step.subscribe needs an executor that supports inboxes, and this one did not say it does. Upgrade the Dev Server (`npx inngest-cli@latest dev`) or use an Inngest Cloud environment with inboxes enabled.",
        );
      }

      const prefix = getAsyncCtxSync()?.execution?.stepIdPrefix ?? "";

      // What the user wrote for each read, learnt when the read is reported.
      const statements = new Map<string, string>();
      const statementOf = (op: string) => {
        return op.endsWith(":read") ? op.slice(0, -":read".length) : op;
      };

      return new Inbox({
        sources: sourcesOf(sources),
        id,
        open: async (_op, opened) => {
          let opening: { id: string } | undefined;

          await step["~inboxOpen"](inboxStatement(id, "subscribe", id), {
            sources: opened,
            track: (op) => {
              opening = op;
            },
          });

          // The engine gives the op a suffix (`inbox:1`) when the run already
          // has a step with its ID, after the op is made. Everything else
          // about the inbox is named from the ID it settled with.
          const final = opening?.id ?? `${prefix}${id}`;

          return {
            id: final.startsWith(prefix) ? final.slice(prefix.length) : final,
            inbox: hashedStepId(final),
          };
        },
        waitId: (op) => {
          return hashedStepId(`${prefix}${op}`);
        },
        wait: (op, inbox, seen, timeout) => {
          return step["~inboxWait"](inboxStatement(op, "next", op), {
            inbox,
            seen,
            ...(timeout === undefined
              ? {}
              : {
                  timeout: timeStr(timeout, this.client[internalLoggerSymbol]),
                }),
          });
        },
        read: (inbox, taken, wait) => {
          return (
            getAsyncCtxSync()?.execution?.inbox?.read(inbox, taken, wait) ?? {
              found: "nothing",
            }
          );
        },
        unread: (inbox, taken, upTo) => {
          return (
            getAsyncCtxSync()?.execution?.inbox?.unread(inbox, taken, upTo) ??
            []
          );
        },
        batch: (op, read) => {
          const name = read.drain ? "drain" : "nextBatch";
          statements.set(op, name);

          return step["~inboxWait"](inboxStatement(op, name, op), {
            inbox: read.inbox,
            seen: read.seen,
            ...(read.timeout === undefined
              ? {}
              : {
                  timeout: timeStr(
                    read.timeout,
                    this.client[internalLoggerSymbol],
                  ),
                }),
            batch: {
              ...(read.drain ? { drain: true } : {}),
              ...(read.unread ? { unread: true } : {}),
              ...(read.max === undefined ? {} : { max: read.max }),
            },
          });
        },
        answered: (op) => {
          return (
            getAsyncCtxSync()?.execution?.stepAnswer?.(`${prefix}${op}`)
              .found === true
          );
        },
        message: (messageId) => {
          return getAsyncCtxSync()?.execution?.inbox?.message(messageId);
        },
        transform: async (op, messageId, message) => {
          const transform = getAsyncCtxSync()?.execution?.inbox?.transform;

          return transform
            ? transform(`${prefix}${op}`, messageId, message)
            : message;
        },
        report: (op, inbox, messages, draw, row) => {
          const runId = getAsyncCtxSync()?.execution?.ctx.runId;

          if (
            messages.length === 0 ||
            runId === undefined ||
            !firstReport(runId, `${prefix}${op}`)
          ) {
            return;
          }

          const statement = statementOf(op);

          void step["~inboxRead"](
            inboxStatement(statement, statements.get(statement) ?? "next", op),
            {
              inbox,
              messages,
              draw,
              ...(row === undefined ? {} : { row }),
            },
          ).catch(() => undefined);
        },
        skip: async (op) => {
          await getAsyncCtxSync()?.execution?.skipStep?.(`${prefix}${op}`);
        },
        lastSeen: () => {
          return getAsyncCtxSync()?.execution?.inbox?.lastSeen() ?? "";
        },
        closed: (op) => {
          return (
            getAsyncCtxSync()?.execution?.stepAnswer?.(`${prefix}${op}`)
              .found === true
          );
        },
        close: (op, closing) => {
          return step["~inboxClose"](
            inboxStatement(op, "close", op),
            closing,
          ) as Promise<Cut>;
        },
        place: async (id) => {
          await getAsyncCtxSync()?.execution?.inbox?.place(id);
        },
      });
    };

    return {
      ...arg,
      ctx: { ...arg.ctx, step: { ...arg.ctx.step, subscribe } },
    };
  }
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Middleware that enables the experimental `step.subscribe()` API: an inbox
 * inside a run that receives every event matching its sources from the moment
 * it opens, read in order whether or not the run is waiting.
 *
 * @example
 * ```ts
 * import { inboxMiddleware } from "inngest/experimental";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   middleware: [inboxMiddleware()],
 * });
 * ```
 */
export const inboxMiddleware = () => InboxMiddleware;
