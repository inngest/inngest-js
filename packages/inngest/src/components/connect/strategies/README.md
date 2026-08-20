# WebSocket thread strategies

This package contains strategies that control whether the WebSocket connection is in the main thread or a worker thread.

The reason for using a worker thread is to prevent userland code from blocking heartbeats and lease extensions. If the WebSocket connection is in the main thread, then users could accidentally make the Inngest server think the worker died when in reality it's just doing CPU intensive work.

We may eventually drop support for the main thread strategy if we confirm that all runtime support it. In theory, there are no advantages to using the main thread strategy.
