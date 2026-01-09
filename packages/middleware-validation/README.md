# @inngest/middleware-validation

This package provides a validation middleware for Inngest, enabling parsing of
incoming and outgoing events using Zod schemas provided using `new
EventSchemas().fromZod()`.

## Features

- Validates incoming event payloads when a function is run
- Validates outgoing event payloads using `inngest.send()` or `step.sendEvent()`
- Optionally disallow events without specified schemas

## Installation

```sh
npm install @inngest/middleware-validation
```

> [!NOTE]
> Requires TypeScript SDK >= 3.23.1

## Usage

To use the validation middleware, import and initialize it.

```ts
import { Inngest, EventSchemas } from "inngest";
import { validationMiddleware } from "@inngest/middleware-validation";
import { z } from "zod";

const inngest = new Inngest({
  id: "my-app",
  middleware: [validationMiddleware()], // just add this
  schemas: new EventSchemas().fromZod({
    "example/event": {
      data: z.object({
        message: z.string(),
      }),
    },
  }),
});
```

By default, simply adding `validationMiddleware()` to an existing client that uses Zod schemas will validate all incoming and outgoing events.

You can provide some extra options to customize the behaviour:

```ts
validationMiddleware({ ... });

{
  /**
   * Disallow events that don't have a schema defined.
   *
   * For this to happen, it probably means that the event is typed using
   * `.fromRecord()` or some other type-only method, and we have no way of
   * validating the payload at runtime.
   *
   * @default false
   */
  disallowSchemalessEvents?: boolean;

  /**
   * Disallow events that have a schema defined, but the schema is unknown and
   * not handled in this code.
   *
   * This is most likely to happen if schemas can be defined using a library not yet
   * supported by this middleware.
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
}
```

> [!NOTE]
> Due to current typing restrictions within middleware, _transforming_
> types is currently unsupported, for example using `z.transform()`. This can be
> introduced in a later update once more mature middleware typing is available,
> likely in `inngest@^4.0.0`.
