# Error Handler Example

This example demonstrates how to specify an error handler for an entire function.

It is triggered by a `demo/error.handler` event, throws an error to exhaust all retries, then runs a function triggered by the failure of the original.
