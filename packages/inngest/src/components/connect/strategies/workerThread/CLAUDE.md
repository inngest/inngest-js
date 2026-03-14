# Worker Thread Strategy

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on the message-passing logging pattern, crash recovery, and the worker/main thread protocol.

## Key Files

- `index.ts` — Main thread side: creates the worker, handles incoming messages, delegates execution
- `runner.ts` — Worker thread side: manages WebSocket connection, heartbeats, lease extensions
- `protocol.ts` — Shared message types for the worker/main thread boundary

## Important Notes

- The logger is not shared across the thread boundary; log messages are serialized via the `LOG` protocol message
- `parsePinoArgs()` in `runner.ts` handles pino-style `(object, string)` log calls
- Always call logger methods directly on `this.internalLogger` (not via extracted references) to preserve `this` binding
