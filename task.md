Fix an issue with `wrapStep` when checkpointing is enabled. The `wrapStep` hook is called twice when a `step.run` is executed:
- 1st call is for serializing the output and sending it to the Inngest Server.
- 2nd call is for deserializing the output and using it within the function handler.

But this causes problems when prepending with a step, since the SDK with think there are 2 prepended steps, rather than 1.

Solve this by adding a new hook called `wrapStepHandler`, which wraps the internal handler for `step.run` (and consequently also `step.sendEvent`). This hook is called once per `step.run` attempt, and gives the opportunity to modify the handler's returned output or thrown error.

This means `wrapStep`'s behavior changes. Its `next` method MUST not return or throw until the underlying step has memoized output/error. This means that the serializer middleware can safely call "deserialize" on its output and be confident it'll only actually return deserialized output to the function handler, and NOT in the HTTP response (or checkpointing's outgoing request).
