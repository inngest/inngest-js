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
 * }, {
 *   event: "user/created",
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

export {
  EventSchemas,
  type AssertInternalEventPayloads,
  type Combine,
  type LiteralZodEventSchema,
  type StandardEventSchemaToPayload,
  type StandardEventSchemas,
  type ZodEventSchemas,
} from "./components/EventSchemas";
export { Inngest } from "./components/Inngest";
export type {
  ClientOptionsFromInngest,
  EventsFromOpts,
  GetEvents,
  GetFunctionInput,
  GetFunctionOutput,
  GetStepTools,
} from "./components/Inngest";
export { InngestCommHandler } from "./components/InngestCommHandler";
export type { ServeHandlerOptions } from "./components/InngestCommHandler";
export type { InngestFunction } from "./components/InngestFunction";
export { referenceFunction } from "./components/InngestFunctionReference";
export type { InngestFunctionReference } from "./components/InngestFunctionReference";
export { InngestMiddleware } from "./components/InngestMiddleware";
export type {
  MiddlewareOptions,
  MiddlewareRegisterFn,
  MiddlewareRegisterReturn,
} from "./components/InngestMiddleware";
export { NonRetriableError } from "./components/NonRetriableError";
export { RetryAfterError } from "./components/RetryAfterError";
export { StepError } from "./components/StepError";
export { headerKeys, internalEvents, queryKeys } from "./helpers/consts";
export { slugify } from "./helpers/strings";
export type {
  IsStringLiteral,
  StrictUnion,
  StrictUnionHelper,
  UnionKeys,
  WithoutInternal,
} from "./helpers/types";
export { ProxyLogger } from "./middleware/logger";
export type { LogArg } from "./middleware/logger";
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
  LogLevel,
  OutgoingOp,
  RegisterOptions,
  ScheduledTimerEventPayload,
  SendEventBaseOutput,
  StepOptions,
  StepOptionsOrId,
  TimeStr,
  JsonError
} from "./types";
