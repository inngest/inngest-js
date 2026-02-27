/**
 * The primary entrypoint for the Inngest SDK. This provides all the necessary
 * exports to create, run, and trigger Inngest functions.
 *
 * Typical usage involves creating a new Inngest client with `Inngest`, and then
 * using the client to create functions, middleware, and other tools.
 *
 * See {@link https://www.inngest.com/docs} for more information.
 *
 * @example Create an Inngest client
 * ```ts
 * const inngest = new Inngest({
 *   id: "my-app-id",
 * });
 * ```
 *
 * @example Create an Inngest function
 * ```ts
 * const myFn = inngest.createFunction({
 *  id: "my-function",
 *  triggers: [{ event: "user/created" }],
 * }, async ({ event, step }) => {
 *   console.log("User created:", event.data);
 * });
 * ```
 *
 * @example Send an event
 * ```ts
 * await inngest.send({
 *   name: "user/created",
 *   data: {
 *     id: "123",
 *   },
 * });
 * ```
 *
 * @module
 */

export * from "@inngest/ai";
export { fetch } from "./components/Fetch.ts";
export type {
  ClientOptionsFromInngest,
  GetFunctionInput,
  GetFunctionOutput,
  GetStepTools,
} from "./components/Inngest";
export { Inngest } from "./components/Inngest.ts";
export type { ServeHandlerOptions } from "./components/InngestCommHandler";
export { InngestCommHandler } from "./components/InngestCommHandler.ts";
export type { InngestFunction } from "./components/InngestFunction";
export type { InngestFunctionReference } from "./components/InngestFunctionReference";
export { referenceFunction } from "./components/InngestFunctionReference.ts";
export { group, step } from "./components/InngestStepTools.ts";
export { Middleware } from "./components/middleware/index.ts";
export { NonRetriableError } from "./components/NonRetriableError.ts";
export { RetryAfterError } from "./components/RetryAfterError.ts";
export { StepError } from "./components/StepError.ts";
export {
  cron,
  EventType,
  eventType,
  invoke,
  staticSchema,
} from "./components/triggers/triggers.ts";
export {
  isInngest,
  isInngestFunction,
  isInngestRequest,
} from "./helpers/assertions.ts";
export { headerKeys, internalEvents, queryKeys } from "./helpers/consts.ts";
export { serializeError } from "./helpers/errors.ts";
export { wrapStringFirstLogger } from "./helpers/log.ts";
export { slugify } from "./helpers/strings.ts";
export type {
  IsStringLiteral,
  SendEventPayload,
  StrictUnion,
  StrictUnionHelper,
  UnionKeys,
} from "./helpers/types";
export { dependencyInjectionMiddleware } from "./middleware/dependencyInjection.ts";
export type { LogArg, Logger } from "./middleware/logger";
export { ConsoleLogger, ProxyLogger } from "./middleware/logger.ts";
export type {
  BaseContext,
  ClientOptions,
  Context,
  EventNameFromTrigger,
  EventPayload,
  FailureEventArgs,
  FailureEventPayload,
  FinishedEventPayload,
  Handler,
  JsonError,
  LogLevel,
  OutgoingOp,
  RegisterOptions,
  ScheduledTimerEventPayload,
  SendEventBaseOutput,
  StepOptions,
  StepOptionsOrId,
  TimeStr,
} from "./types";
export { version } from "./version.ts";
