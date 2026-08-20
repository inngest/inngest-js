import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../../helpers/consts";
import type { InngestFunction } from "../InngestFunction";
import { NonRetriableError } from "../NonRetriableError";
import { EventType } from "./triggers";
import type { AnySchema } from "./typeHelpers";

/**
 * A validator function that validates event data against a schema. A `null`
 * value means no validation is needed (e.g. trigger has no schema).
 */
type EventValidator = ((data: unknown) => Promise<void>) | null;

/**
 * Maps trigger names to their validators. A `null` value means no validation is
 * needed (e.g. trigger has no schema).
 */
type ValidatorsByTrigger = Record<string, EventValidator>;

/**
 * Maps trigger names to their associated schemas. Multiple schemas can exist
 * for the same trigger name (e.g. from multiple events).
 */
type SchemasByTrigger = Record<string, AnySchema[]>;

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
 * Validates data against a single schema, throwing an EventValidationError if
 * validation fails.
 */
async function validateAgainstSchema(
  schema: AnySchema,
  data: unknown,
): Promise<void> {
  const result = await schema["~standard"].validate(data);
  if (result.issues) {
    throw EventValidationError.fromIssues(result.issues);
  }
}

/**
 * Finds all validators that match an event name via wildcard patterns.
 *
 * A wildcard trigger like "user/*" matches any event starting with "user/".  An
 * event like "user/foo/bar" can match multiple wildcards (e.g. "user/*" and
 * "user/foo/*").
 *
 * @returns Array of validators for matching wildcard triggers. Includes `null`
 *          entries for wildcards without schemas (meaning "no validation
 *          needed").
 */
function findWildcardValidators(
  eventName: string,
  validators: ValidatorsByTrigger,
): EventValidator[] {
  const matchingValidators: EventValidator[] = [];

  for (const [triggerName, validator] of Object.entries(validators)) {
    const isWildcard = triggerName.endsWith("*");
    if (!isWildcard) {
      continue;
    }

    const wildcardPrefix = triggerName.slice(0, -1);
    const matchesWildcard = eventName.startsWith(wildcardPrefix);
    if (matchesWildcard) {
      matchingValidators.push(validator);
    }
  }

  return matchingValidators;
}

/**
 * Creates a combined validator that runs all provided validators and succeeds
 * if at least one passes (i.e. union validation).
 */
function createUnionValidator(validators: EventValidator[]): EventValidator {
  const nonNullValidators = validators.filter(isNotNull);

  if (nonNullValidators.length === 0) {
    return null;
  }

  return async (data: unknown) => {
    const promises = nonNullValidators.map((validator) => {
      return validator(data);
    });
    await throwIfAllRejected(promises);
  };
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
  TTriggers extends readonly InngestFunction.Trigger<string>[],
>(
  events: readonly { name: string; data: unknown }[],
  triggers: TTriggers,
): Promise<void> {
  const schemasByTrigger = createSchemasByTrigger(triggers);
  const validatorsByTrigger = createValidatorsByTrigger(schemasByTrigger);

  const validationPromises: Promise<void>[] = [];
  for (const event of events) {
    const validator = getValidatorForEvent(event.name, validatorsByTrigger);

    if (validator === null) {
      // Event is allowed but has no schema to validate against
      continue;
    }

    validationPromises.push(validator(event.data));
  }

  // Validate all events in parallel. First error will propagate.
  await Promise.all(validationPromises);
}

/**
 * Gets the appropriate validator for an event, handling both direct matches
 * and wildcard pattern matching.
 *
 * @throws EventValidationError if the event doesn't match any triggers
 */
function getValidatorForEvent(
  eventName: string,
  validatorsByEvent: ValidatorsByTrigger,
): EventValidator {
  // Case 1: Direct match - event name is explicitly registered
  const directValidator = validatorsByEvent[eventName];
  if (directValidator !== undefined) {
    return directValidator;
  }

  // Case 2: Wildcard match - event name matches one or more wildcard patterns
  const wildcardValidators = findWildcardValidators(
    eventName,
    validatorsByEvent,
  );

  if (wildcardValidators.length > 0) {
    // At least one wildcard matched. If any wildcard has no schema (null), we
    // still need to track it since it means "this event is allowed".
    return createUnionValidator(wildcardValidators);
  }

  // Case 3: No match - event is not recognized by any trigger. This can occur
  // when a trigger is removed but the app isn't resynced.
  throw new EventValidationError(`Event not found in triggers: ${eventName}`);
}

/**
 * Parses a trigger to extract its event name and optional schema.
 *
 * Triggers can be specified in several forms:
 * - Direct EventType: `eventType("my-event")`
 * - Nested EventType: `{ event: eventType("my-event") }`
 * - String event name: `{ event: "my-event" }`
 * - Cron trigger: `cron("0 0 * * *")`
 *
 * @returns The event name and schema (null if no schema is attached)
 * @throws EventValidationError if the trigger format is invalid
 */
function parseTrigger(trigger: InngestFunction.Trigger<string>): {
  eventName: string;
  schema: AnySchema | null;
} {
  // Direct event type trigger (e.g. `eventType("my-event")`)
  if (trigger instanceof EventType) {
    return { eventName: trigger.name, schema: trigger.schema };
  }

  // Nested event type trigger (e.g. `{ event: eventType("my-event") }`)
  if (trigger.event instanceof EventType) {
    return { eventName: trigger.event.name, schema: trigger.event.schema };
  }

  // String event name trigger (e.g. `{ event: "my-event" }`)
  if (typeof trigger.event === "string") {
    return { eventName: trigger.event, schema: null };
  }

  // Cron trigger (e.g. `cron("0 0 * * *")`)
  if (trigger.cron) {
    return { eventName: internalEvents.ScheduledTimer, schema: null };
  }

  throw new EventValidationError("Invalid trigger");
}

/**
 * Create a map of trigger names to their schemas.
 */
function createSchemasByTrigger(
  triggers: readonly InngestFunction.Trigger<string>[],
): SchemasByTrigger {
  const schemasByEvent: SchemasByTrigger = {};

  for (const trigger of triggers) {
    const { eventName, schema } = parseTrigger(trigger);

    if (schema) {
      const existingSchemas = schemasByEvent[eventName] ?? [];
      schemasByEvent[eventName] = [...existingSchemas, schema];
    } else {
      schemasByEvent[eventName] = schemasByEvent[eventName] ?? [];
    }
  }

  return schemasByEvent;
}

/**
 * Creates a validator that validates data against multiple schemas, succeeding
 * if at least one schema passes (union validation).
 */
function createSchemaUnionValidator(schemas: AnySchema[]): EventValidator {
  if (schemas.length === 0) {
    return null;
  }

  return async (data: unknown) => {
    const validationPromises = schemas.map((schema) =>
      validateAgainstSchema(schema, data),
    );
    await throwIfAllRejected(validationPromises);
  };
}

/**
 * Create a map of trigger names to their validators.
 *
 * If no invoke schemas are specified, the invoke schema is implicitly a union
 * of all event schemas.
 */
function createValidatorsByTrigger(
  schemasByTrigger: SchemasByTrigger,
): ValidatorsByTrigger {
  const validatorsByTrigger: ValidatorsByTrigger = {};

  // Create a validator for each event based on its schemas
  for (const [triggerName, schemas] of Object.entries(schemasByTrigger)) {
    validatorsByTrigger[triggerName] = createSchemaUnionValidator(schemas);
  }

  // Handle implicit invoke validation: if no explicit invoke trigger is
  // defined, validate invoked events against the union of all event schemas
  const hasExplicitInvokeValidator =
    validatorsByTrigger[internalEvents.FunctionInvoked] !== undefined;

  if (!hasExplicitInvokeValidator) {
    // No explicit invoke validator, so we need to build an implicit one. The
    // implicit validator is a union of all event schemas.

    const allSchemas = Object.values(schemasByTrigger).flat();
    validatorsByTrigger[internalEvents.FunctionInvoked] =
      createSchemaUnionValidator(allSchemas);
  }

  return validatorsByTrigger;
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

function isNotNull<T>(value: T): value is NonNullable<T> {
  return value !== null;
}
