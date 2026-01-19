import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../../helpers/consts";
import type { InngestFunction } from "../InngestFunction";
import { NonRetriableError } from "../NonRetriableError";
import { EventType } from "./triggers";
import type { AnySchema } from "./typeHelpers";

class EventValidationError extends NonRetriableError {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  static fromIssues(
    issues: readonly StandardSchemaV1.Issue[],
  ): EventValidationError {
    if (issues.length === 0) {
      // Unreachable
      return new EventValidationError("Validation failed");
    }

    const message = issues
      .map((issue) => {
        let path = "value";
        if (issue.path && issue.path.length > 0) {
          path = issue.path.join(".");
        }
        return `${path}: ${issue.message}`;
      })
      .join(", ");

    return new EventValidationError(message);
  }
}

/**
 * Validates a tuple of events against a tuple of triggers. Throws an error if
 * there's at least 1 event fails validation.
 *
 * Some special behaviors:
 * - If no invoke trigger is present, invoke events are validated against all
 *   event schemas.
 * - If 1 or more invoke triggers is present, invoke events are only validated
 *   against the invoke trigger schemas.
 */
export async function validateEvents<
  TEvents extends readonly { name: string; data: unknown }[],
  TTriggers extends readonly InngestFunction.Trigger<string>[],
>(events: TEvents, triggers: TTriggers): Promise<TEvents> {
  const eventSchemas = createEventSchemas(triggers);
  const eventValidators = createEventValidators(eventSchemas);

  const promises: Promise<void>[] = [];
  for (const event of events) {
    const validate = eventValidators[event.name];
    if (validate === undefined) {
      // Can happen if a trigger is removed but the app wasn't resynced. For
      // example:
      // 1. Function is synced with "my-event" trigger
      // 2. Function is synced with Inngest
      // 3. Function is redeployed with "my-event" trigger removed, but not
      //    resynced with Inngest
      // 4. Function is triggered by "my-event"

      throw new EventValidationError(
        `Event not found in triggers: ${event.name}`,
      );
    }
    if (validate === null) {
      // No validator
      continue;
    }
    promises.push(validate(event.data));
  }

  // Validate in parallel. Allow the first encountered error to propagate
  await Promise.all(promises);

  return events;
}

/**
 * Only throw if all promises are rejected.
 */
async function throwIfAllRejected(promises: Promise<void>[]) {
  const settled = await Promise.allSettled(promises);

  let error: Error | undefined;
  for (const result of settled) {
    if (result.status === "rejected") {
      error = result.reason;
    }
    if (result.status === "fulfilled") {
      return;
    }
  }
  if (error) {
    throw error;
  }
}

/**
 * Create a map of event names to their schemas.
 */
function createEventSchemas(
  triggers: readonly InngestFunction.Trigger<string>[],
): Record<string, AnySchema[]> {
  const out: Record<string, AnySchema[]> = {};

  for (const trigger of triggers) {
    let eventName: string;
    let schema: AnySchema | null = null;
    if (trigger instanceof EventType) {
      // Event type directly used as a trigger.
      // Example: `eventType("my-event")`

      eventName = trigger.name;
      schema = trigger.schema;
    } else if (trigger.event instanceof EventType) {
      // Event type nested in the `event` property.
      // Example: `{ event: eventType("my-event") }`

      eventName = trigger.event.name;
      schema = trigger.event.schema;
    } else if (typeof trigger.event === "string") {
      // Event name directly used as a trigger.
      // Example: `{ event: "my-event" }`

      eventName = trigger.event;
      schema = null;
    } else if (trigger.cron) {
      // Cron trigger.
      // Example: `cron("0 0 * * *")`

      eventName = internalEvents.ScheduledTimer;
      schema = null;
    } else {
      // Only reachable if the user specifies an invalid trigger

      throw new EventValidationError("Invalid trigger");
    }

    if (schema) {
      // Append the schema
      const oldSchemas = out[eventName] ?? [];
      out[eventName] = [...oldSchemas, schema];
    } else {
      out[eventName] = [];
    }
  }

  return out;
}

/**
 * Create a map of event names to their validators.
 *
 * If no invoke schemas are specified, the invoke schema is implicitly a union
 * of all event schemas.
 */
function createEventValidators(
  eventSchemas: Record<string, AnySchema[]>,
): Record<string, ((data: unknown) => Promise<void>) | null> {
  const out: Record<string, ((data: unknown) => Promise<void>) | null> = {};

  for (const [eventName, schemas] of Object.entries(eventSchemas)) {
    if (schemas.length === 0) {
      // No schemas, so no validator
      out[eventName] = null;
      continue;
    }

    out[eventName] = async (data: unknown) => {
      // Validate against all schemas in parallel. Ignore validation errors if
      // at least 1 succeeds.

      const promises = schemas.map((schema) => {
        return (async () => {
          const result = await schema["~standard"].validate(data);
          if (result.issues) {
            throw EventValidationError.fromIssues(result.issues);
          }
        })();
      });

      await throwIfAllRejected(promises);
    };
  }

  if (out[internalEvents.FunctionInvoked] === undefined) {
    // No explicit invoke schema, so make it a union of all event schemas

    out[internalEvents.FunctionInvoked] = async (data: unknown) => {
      // Flatten into an array of all schemas
      const allSchemas = Object.values(eventSchemas)
        .map((schemas) => schemas)
        .flat();

      const promises = allSchemas.map((schema) => {
        return (async () => {
          const result = await schema["~standard"].validate(data);
          if (result.issues) {
            throw EventValidationError.fromIssues(result.issues);
          }
        })();
      });
      await throwIfAllRejected(promises);
    };
  }
  return out;
}
