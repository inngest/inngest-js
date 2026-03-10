# Worker Thread Architecture

## Overview

The worker thread strategy runs the WebSocket connection, heartbeater, and lease extender in a separate Node.js worker thread (`runner.ts`). Userland function execution remains on the main thread. This prevents CPU-intensive user code from blocking connection health checks.

## Logging

The worker thread cannot directly use the SDK's logger because:

1. The `Logger` instance (from `middleware/logger.ts`) is not serializable across the worker thread boundary
2. The logger is bound to the main thread's `Inngest` client instance

Instead, the worker thread uses a **message-passing pattern** for logging:

1. `runner.ts` creates a lightweight `Logger`-compatible object via `createMessageLogger()`
2. Each log call is parsed by `parsePinoArgs()` into `{ message, data? }` to handle pino-style `(object, string)` and simple `(string)` call signatures
3. The parsed log is sent to the main thread as a `LOG` message (see `WorkerToMainMessage` in `protocol.ts`)
4. The main thread's `handleWorkerLog()` in `index.ts` receives the message and calls the real logger

The `data` field is typed as `Record<string, unknown> | undefined` (not `unknown`) because all logging in this module is internal and always uses pino-style structured logging.

## Message Protocol

See `protocol.ts` for the full message types. Key message flows:

- **Main -> Worker**: `INIT` (config), `CONNECT`, `CLOSE`, `EXECUTION_RESPONSE`, `EXECUTION_ERROR`
- **Worker -> Main**: `STATE_CHANGE`, `CONNECTION_READY`, `ERROR`, `EXECUTION_REQUEST`, `CLOSED`, `LOG`

## Crash Recovery

The main thread monitors the worker's exit events. If the worker exits unexpectedly (state is not `CLOSING`/`CLOSED`), it assumes a crash and respawns with exponential backoff (500ms base, 30s max, up to 10 consecutive crashes before giving up). The crash counter resets on a successful `CONNECTION_READY`.
