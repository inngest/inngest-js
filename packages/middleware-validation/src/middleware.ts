import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type EventPayload,
  type InngestFunction,
  InngestMiddleware,
  internalEvents,
  type MiddlewareOptions,
  NonRetriableError,
} from "inngest";
import type { ZodObject } from "zod";

/**
 * Middleware that validates events using Zod schemas passed using
 * `EventSchemas.fromZod()`.
 */
export const validationMiddleware = (opts?: {
  /**
   * Disallow events that don't have a schema defined.
   *
   * @default false
   */
  disallowSchemalessEvents?: boolean;

  /**
   * Disallow events that have a schema defined, but the schema is unknown and
   * not handled in this code.
   *
   * @default false
   */
  disallowUnknownSchemas?: boolean;

  /**
   * Disable validation of incoming events.
   *
   * @default false
   */
  disableIncomingValidation?: boolean;

  /**
   * Disable validation of outgoing events using `inngest.send()` or
   * `step.sendEvent()`.
   *
   * @default false
   */
  disableOutgoingValidation?: boolean;
}): InngestMiddleware<MiddlewareOptions> => {
  const mw = new InngestMiddleware({
    name: "Inngest: Runtime schema validation",
    init({ client }) {
      /**
       * Given an `event`, validate it against its schema.
       */
      const validateEvent = async (
        event: EventPayload,
        potentialInvokeEvents: string[] = [],
      ): Promise<EventPayload> => {
        let schemasToAttempt = new Set<string>([event.name]);
        let hasSchema = false;

        /**
         * Trust internal events; don't allow overwriting their typing.
         */
        if (event.name.startsWith("inngest/")) {
          if (event.name !== internalEvents.FunctionInvoked) {
            return event;
          }

          /**
           * If this is an `inngest/function.invoked` event, try validating the
           * payload against one of the function's schemas.
           */
          schemasToAttempt = new Set<string>(potentialInvokeEvents);

          hasSchema = [...schemasToAttempt.values()].some((schemaName) => {
            return Boolean(client["schemas"]?.["runtimeSchemas"][schemaName]);
          });
        } else {
          hasSchema = Boolean(
            client["schemas"]?.["runtimeSchemas"][event.name],
          );
        }

        if (!hasSchema) {
          if (opts?.disallowSchemalessEvents) {
            throw new NonRetriableError(
              `Event "${event.name}" has no schema defined; disallowing`,
            );
          }

          return event;
        }

        const errors: Record<string, Error> = {};

        for (const schemaName of schemasToAttempt) {
          try {
            const schema = client["schemas"]?.["runtimeSchemas"][schemaName];

            /**
             * The schema could be a full Zod object.
             */
            if (helpers.isZodObject(schema)) {
              const check = await schema.passthrough().safeParseAsync(event);

              if (check.success) {
                return check.data as unknown as EventPayload;
              }

              throw new NonRetriableError(
                `${check.error.name}: ${check.error.message}`,
              );
            }

            /**
             * It could be a Standard Schema v1 object.
             */
            if (helpers.isStandardSchema(schema)) {
              const check = await schema["~standard"].validate(event);

              if (!check.issues) {
                return check.value as unknown as EventPayload;
              }

              throw new NonRetriableError(
                `${check.issues.map((issue) => `${issue.message} at ${issue.path}`).join(", ")}`,
              );
            }

            /**
             * The schema could also be a regular object with Zod objects
             * inside.
             */
            if (helpers.isObject(schema)) {
              // It could be a partial schema; validate each field
              return await Object.keys(schema).reduce<Promise<EventPayload>>(
                async (acc, key) => {
                  const fieldSchema = schema[key];
                  const eventField = event[key as keyof EventPayload];

                  if (!eventField) {
                    return acc;
                  }

                  if (helpers.isStandardSchema(fieldSchema)) {
                    const check =
                      await fieldSchema["~standard"].validate(eventField);

                    if (!check.issues) {
                      return {
                        ...(await acc),
                        [key]: check.value,
                      };
                    }

                    throw new NonRetriableError(
                      `${check.issues.map((issue) => `${issue.message} at ${issue.path}`).join(", ")}`,
                    );
                  } else if (helpers.isZodObject(fieldSchema)) {
                    const check = await fieldSchema
                      .passthrough()
                      .safeParseAsync(eventField);

                    if (check.success) {
                      return { ...(await acc), [key]: check.data };
                    }

                    throw new NonRetriableError(
                      `${check.error.name}: ${check.error.message}`,
                    );
                  }

                  // Nothing matched
                  return acc;
                },
                Promise.resolve<EventPayload>({ ...event }),
              );
            }

            /**
             * Didn't find anything? Throw or warn.
             *
             * We only allow this for assessing single schemas, as otherwise
             * we're assessing an invocation would could be multiple.
             */
            if (opts?.disallowUnknownSchemas && schemasToAttempt.size === 1) {
              throw new NonRetriableError(
                `Event "${event.name}" has an unknown schema; disallowing`,
              );
            } else {
              console.warn(
                "Unknown schema found; cannot validate, but allowing",
              );
            }
          } catch (err) {
            errors[schemaName] = err as Error;
          }
        }

        if (Object.keys(errors).length) {
          throw new NonRetriableError(
            `Event "${event.name}" failed validation:\n\n${Object.keys(errors)
              .map((key) => `Using ${key}: ${errors[key].message}`)
              .join("\n\n")}`,
          );
        }

        return event;
      };

      return {
        ...(opts?.disableIncomingValidation
          ? {}
          : {
              async onFunctionRun({ fn }) {
                const backupEvents = (
                  (fn.opts as InngestFunction.Options).triggers || []
                ).reduce<string[]>((acc, trigger) => {
                  if (trigger.event) {
                    return [...acc, trigger.event];
                  }

                  return acc;
                }, []);

                return {
                  async transformInput({ ctx: { events } }) {
                    const validatedEvents = await Promise.all(
                      events.map((event) => {
                        return validateEvent(event, backupEvents);
                      }),
                    );

                    return {
                      ctx: {
                        event: validatedEvents[0],
                        events: validatedEvents,
                      } as {},
                    };
                  },
                };
              },
            }),

        ...(opts?.disableOutgoingValidation
          ? {}
          : {
              async onSendEvent() {
                return {
                  async transformInput({ payloads }) {
                    return {
                      payloads: await Promise.all(
                        payloads.map((payload) => {
                          return validateEvent(payload);
                        }),
                      ),
                    };
                  },
                };
              },
            }),
      };
    },
  });

  return mw;
};

const helpers = {
  isZodObject: (value: unknown): value is ZodObject<any> => {
    try {
      return (value as any)?._def?.typeName === "ZodObject";
    } catch {
      return false;
    }
  },

  isStandardSchema: (value: unknown): value is StandardSchemaV1 => {
    try {
      return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as any)?.["~standard"] !== "undefined"
      );
    } catch {
      return false;
    }
  },

  isObject: (value: unknown): value is Record<string, any> => {
    try {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    } catch {
      return false;
    }
  },
};
