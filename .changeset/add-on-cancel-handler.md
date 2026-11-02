---
"inngest": minor
---

Add an `onCancel` option to `createFunction()`. Like `onFailure`, it registers a companion function that runs when the function is cancelled, whether by `cancelOn`, a timeout, or the REST API. The handler receives the `inngest/function.cancelled` event, with the event that triggered the cancelled run at `event.data.event`.

`CancelledEventPayload` and the new `CancelledEventArgs` are now exported, and `CancelledEventPayload` includes the triggering `event`, matching what Inngest sends.
