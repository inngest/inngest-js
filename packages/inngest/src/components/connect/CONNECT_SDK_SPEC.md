# Inngest Connect Protocol — SDK Specification

This document describes the complete Inngest Connect protocol — the persistent
WebSocket-based protocol between SDK workers and the Inngest Gateway. It is
derived from the Go gateway implementation (`oss/pkg/connect/gateway.go`) and
the JS SDK implementation (`packages/inngest/src/components/connect/`).

---

## 1. Connection Establishing / Handshake

### HTTP Start Request

- `POST {apiBaseUrl}/v0/connect/start`
- Headers: `Authorization: Bearer {hashedSigningKey}`, `X-Inngest-Env: {envName}` (optional)
- Body: `StartRequest` protobuf with `excludeGateways[]`
- Response: `StartResponse` protobuf with `connectionId`, `gatewayEndpoint`, `gatewayGroup`, `sessionToken`, `syncToken`
- Error responses: 401 (auth failed → switch key), 429 (connection limit), other 4xx/5xx (generic retry)

### WebSocket Setup

- Connect to `gatewayEndpoint` with subprotocol `v0.connect.inngest.com`
- `binaryType = "arraybuffer"`
- All messages are binary protobuf `ConnectMessage { kind, payload }`

### Handshake Sequence (strict 3-message order)

1. **Gateway → Worker:** `GATEWAY_HELLO` (empty payload)
2. **Worker → Gateway:** `WORKER_CONNECT` (within 5s on gateway side, 10s timeout on worker side)
   - Fields: connectionId, instanceId (required), authData (sessionToken + syncToken), capabilities, apps[], systemAttributes, environment, framework ("connect"), platform, sdkVersion, sdkLanguage ("typescript"), startedAt, maxWorkerConcurrency
3. **Gateway → Worker:** `GATEWAY_CONNECTION_READY`
   - Payload: `heartbeatInterval` (default "10s"), `extendLeaseInterval` (default "5s" = leaseDuration/4), `statusInterval` (default "0s" = disabled)
   - Worker parses duration strings with `ms()`, falls back to 10s / 5s if empty

### Handshake Errors

- Gateway validates ULID format for connectionId, non-empty instanceId, app count ≤ 100
- Any deviation from the 3-message sequence → `ReconnectError` on worker, close with syscode on gateway
- `SYNC_FAILED` message sent if app synchronization fails

---

## 2. Heartbeats

### Flow

Worker-initiated, gateway responds.

- Worker sends `WORKER_HEARTBEAT` (empty payload) every `heartbeatIntervalMs`
- Gateway responds with `GATEWAY_HEARTBEAT` (empty payload) within 5s write timeout
- Gateway also updates connection status to READY and refreshes worker capacity TTL

### Worker-side miss detection (JS SDK)

- `pendingHeartbeats` counter incremented on each send
- Reset to 0 on `GATEWAY_HEARTBEAT` receipt
- If `pendingHeartbeats >= 2`: mark connection dead, wake reconcile loop → reconnect

### Gateway-side miss detection (Go gateway)

- Checks `time.Since(lastHeartbeat) > consecutiveMisses * heartbeatInterval`
- Default: 5 consecutive misses × 10s = 50s timeout
- On timeout: cancel connection context with reason `CONSECUTIVE_HEARTBEATS_MISSED`

### During draining (WORKER_PAUSE sent or gateway draining)

- Heartbeats still accepted by gateway
- Gateway sets status to DRAINING instead of READY
- Heartbeats do NOT reset draining state back to READY

---

## 3. Job Processing and Lease Extensions

### Request Flow

1. **Gateway → Worker:** `GATEWAY_EXECUTOR_REQUEST`
   - Fields: requestId, accountId, envId, appId, appName, functionId, functionSlug, stepId (optional), requestPayload, systemTraceCtx, userTraceCtx, runId, leaseId

2. **Worker validates:** state is ACTIVE, appName is non-empty, appName is in registered appIds
   - If invalid: skip silently (no ACK sent)

3. **Worker → Gateway:** `WORKER_REQUEST_ACK` (sent immediately)
   - Fields: requestId, accountId, envId, appId, functionSlug, stepId, systemTraceCtx, userTraceCtx, runId
   - Gateway forwards ACK to executor via gRPC

4. **Worker begins execution + starts lease extension interval**

5. **Worker → Gateway:** `WORKER_REQUEST_EXTEND_LEASE` (every `extendLeaseIntervalMs`, default 5s)
   - Fields: requestId, accountId, envId, appId, functionSlug, stepId, systemTraceCtx, userTraceCtx, runId, leaseId (current)
   - Uses latest active connection (falls back to original if draining)

6. **Gateway → Worker:** `WORKER_REQUEST_EXTEND_LEASE_ACK`
   - `newLeaseId` present → worker updates stored leaseId for subsequent extensions
   - `newLeaseId` absent → lease no longer needed; worker deletes from tracking, extensions stop
   - NACK reasons: lease expired, another worker claimed it, request not found

7. **Worker → Gateway:** `WORKER_REPLY` (after execution completes)
   - Payload: raw response bytes (SDKResponse protobuf)
   - If no active connection: buffer response for HTTP flush via `onBufferResponse`

8. **Gateway → Worker:** `WORKER_REPLY_ACK`
   - Fields: requestId
   - Worker calls `onReplyAck` callback

### Lease Constants

- Initial lease duration: 20s (`ConnectWorkerRequestLeaseDuration`)
- Extension interval: 5s (`ConnectWorkerRequestExtendLeaseInterval` = duration / 4)

---

## 4. Gateway Draining and Reconnection

### Gateway Draining (initiated by gateway shutdown/deployment)

1. Gateway sets `isDraining` flag, rejects new WS connections
2. **Gateway → Worker:** `GATEWAY_CLOSING` (empty payload, 5s write timeout)
3. Gateway waits up to 5s for worker to close gracefully
4. If timeout: forcefully closes with `ErrDraining` (status 1001, syscode `CodeConnectGatewayClosing`)

### Expected Worker Behavior on `GATEWAY_CLOSING`

1. Move current active connection → draining slot
2. Clear active connection → triggers reconcile loop to establish replacement
3. New connection via `/v0/connect/start` with failed gateway in `excludeGateways`
4. After new connection is ACTIVE: close old draining connection
5. In-flight requests continue on draining connection; lease extensions use new connection when available

### Reconnection Triggers

- WebSocket error or close event
- Heartbeat miss threshold reached (2 on worker side)
- `GATEWAY_CLOSING` received
- HTTP start request failure (non-terminal)

### Exponential Backoff (JS SDK)

```
[1s, 2s, 5s, 10s, 20s, 30s, 60s, 120s, 300s]
```

- Index = `Math.min(attempt, array.length - 1)`
- Backoff can be cancelled early if shutdown requested and no in-flight requests

### Auth Key Fallback

- On 401 (`AuthError`): switch between `hashedSigningKey` and `hashedFallbackKey`
- Retry with switched key on next attempt

### excludeGateways Mechanism

- Worker tracks failed gateway groups in a `Set`
- Passed in `StartRequest.excludeGateways[]` so API returns a different gateway
- Cleared on successful connection to that group

### State Transitions

```
CONNECTING → (success) → ACTIVE
CONNECTING → (error)   → backoff → CONNECTING
ACTIVE     → (ws error/close/drain/heartbeat miss) → RECONNECTING
RECONNECTING → (success) → ACTIVE
RECONNECTING → (error)   → backoff → RECONNECTING
(any)      → close()  → loop exits → CLOSED
```

---

## 5. Worker Status Reporting

### Overview

The gateway can opt the worker into periodic status reporting by sending a
non-zero `statusInterval` in the `GATEWAY_CONNECTION_READY` payload. When
enabled, the worker sends `WORKER_STATUS` messages at the configured cadence
so the gateway can observe in-flight work and shutdown state.

### Configuration

- `statusInterval` is a duration string (e.g. "5s", "200ms")
- "0s" or "" disables reporting (default)
- Interval can change on reconnection (each handshake may return a different value)

### Message: `WORKER_STATUS` (Worker → Gateway)

Payload: `WorkerStatusData` protobuf
- `inFlightRequestIds`: request IDs currently being processed
- `shutdownRequested`: whether the worker has initiated graceful shutdown

### Gateway-side handling

- Rate-limited: at most one message per 2 seconds; faster messages silently dropped
- Payload logged at debug level; no state mutations

### Worker-side implementation (`StatusReporter`)

- Timer started/restarted on each `GATEWAY_CONNECTION_READY` via `updateInterval()`
- Stopped on `close()` or when interval set to 0
- Skips send if WebSocket is not open or no active connection

---

## 6. Worker Graceful Shutdown

### Initiation

`close()` called (or SIGINT/SIGTERM signal).

### Shutdown Sequence

1. Set `_shutdownRequested = true`

2. If active connection is open, send `WORKER_PAUSE` (empty payload)
   - Gateway marks connection as DRAINING in state store
   - Gateway removes connection from routing map (no new requests forwarded)
   - Gateway sets `ch.draining` flag so heartbeats don't reset to READY

3. Wake reconcile loop

4. **Heartbeats continue** — the heartbeat manager keeps running until the reconcile loop exits
   - Gateway still accepts heartbeats during draining, maintains DRAINING status
   - This keeps the connection alive for in-flight lease extensions

5. **In-flight requests complete:**
   - Reconcile loop exit condition: `shutdownRequested && !hasInFlightRequests()`
   - `hasInFlightRequests()` checks `Object.keys(requestLeases).length > 0`
   - Each completing request calls `wg.done()` and deletes from `requestLeases`
   - Last request completion wakes the loop if shutdown pending

6. **Loop exits:**
   - Heartbeat manager stopped
   - Active connection closed
   - Draining connection closed (if any)

7. `close()` promise resolves

### WebSocket Close

Worker should close WebSocket with:
- Code: 1000 (Normal Closure)
- Reason: `"WORKER_SHUTDOWN"`
- Gateway recognizes this as expected shutdown

### Backoff cancellation during shutdown

- If shutdown requested during exponential backoff wait, `waitWithCancel` checks
  `shutdownRequested && !hasInFlightRequests()` every 100ms
- If condition met: backoff cancelled, loop exits immediately

---

## Protocol Constants Reference

| Constant | Value | Source |
|---|---|---|
| Heartbeat interval (default) | 10s | `ConnectWorkerHeartbeatInterval` |
| Lease duration | 20s | `ConnectWorkerRequestLeaseDuration` |
| Lease extension interval (default) | 5s | `leaseDuration / 4` |
| Gateway heartbeat miss threshold | 5 consecutive | `consecutiveWorkerHeartbeatMissesBeforeConnectionClose` |
| Worker heartbeat miss threshold | 2 consecutive | `pendingHeartbeats >= 2` in HeartbeatManager |
| WS write timeout (gateway) | 5s | `wsWriteTimeout` |
| Handshake timeout (gateway) | 5s | context timeout on initial read |
| Handshake timeout (worker) | 10s | setTimeout in establishConnection |
| Drain grace period | 5s | `time.After(5 * time.Second)` after GATEWAY_CLOSING |
| Max apps per connection | 100 | `MaxAppsPerConnection` |
| WS subprotocol | `v0.connect.inngest.com` | `types.GatewaySubProtocol` |
| Backoff schedule (JS SDK) | 1s, 2s, 5s, 10s, 20s, 30s, 60s, 120s, 300s | `expBackoff()` |
| Status interval (default) | 0s (disabled) | `ConnectWorkerStatusInterval` |
| Status rate limit (gateway) | 2s | hardcoded in `handleIncomingWebSocketMessage` |
