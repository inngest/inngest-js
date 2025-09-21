# Connect Component Refactoring Specification

## Background

The connect component (`src/components/connect/index.ts`) is a critical piece of the Inngest JavaScript SDK that enables persistent connections to the Inngest gateway for real-time function execution. However, the current implementation has several maintainability and testing challenges that need to be addressed.

### Current Issues

1. **Monolithic Class**: The `WebSocketWorkerConnection` class is ~1300 lines handling multiple responsibilities
2. **Complex State Management**: Manual state tracking with no formal state machine
3. **Nested Callbacks**: Deep callback nesting makes the code hard to follow and debug
4. **Mixed Concerns**: Connection management, message handling, and error handling are intertwined
5. **Poor Logging**: Debug statements scattered throughout with no structured logging
6. **No Comprehensive Tests**: Limited test coverage for connect functionality
7. **Special Case Handling**: Gateway draining logic mixed into main connection flow
8. **Hard to Test**: Monolithic design makes unit testing individual components difficult

### Goals

- **Maintainability**: Break down the monolithic class into focused, single-responsibility components
- **Testability**: Enable comprehensive unit and integration testing with >95% coverage
- **Reliability**: Ensure no regressions in existing functionality while improving error handling
- **Observability**: Provide clear, structured logging for debugging production issues
- **Performance**: Maintain or improve connection performance and resource usage

## Architecture Overview

The refactored connect component will follow these design patterns:

### Design Patterns Used

1. **State Machine Pattern**: Manage connection states and transitions with formal validation
2. **Observer Pattern**: Event-driven architecture with state change notifications
3. **Strategy Pattern**: Different connection retry and error handling strategies
4. **Factory Pattern**: Create appropriate message handlers and connections
5. **Composition Pattern**: Combine focused components rather than inheritance
6. **Command Pattern**: Encapsulate connection operations and message handling

### Component Architecture

```
WebSocketWorkerConnection (Orchestrator)
├── ConnectionStateMachine (State Management)
├── MessageHandler (Protocol Logic) 
├── WebSocketManager (Transport Layer)
├── ConnectLogger (Observability)
└── MessageBuffer (Reliability)
```

## Implementation Phases

### Phase 0: Test Infrastructure ✅ COMPLETED
**Goal**: Establish comprehensive test infrastructure before refactoring

**Deliverables**:
- `MockWebSocketServer` class using Node.js `ws` library
- `MockHTTPServer` class using Node.js `http` module  
- `ConnectionTestHarness` for simulating real network conditions
- **Characterization tests** capturing current behavior (11 tests covering basic API)

**Success Criteria**: All characterization tests pass with current implementation

### Phase 1: ConnectionStateMachine ✅ COMPLETED
**Goal**: Create a formal state machine to manage connection states and transitions

**Deliverables**:
- `ConnectionStateMachine` class with proper state transition management
- States: `CONNECTING`, `ACTIVE`, `RECONNECTING`, `DRAINING_RECONNECTING`, `CLOSING`, `CLOSED`
- Events: `CONNECT_REQUESTED`, `WEBSOCKET_OPEN`, `AUTH_SUCCESS`, `GATEWAY_READY`, `DRAINING_REQUESTED`, `NEW_CONNECTION_READY`, `ERROR_OCCURRED`, `SHUTDOWN_REQUESTED`, `CONNECTION_LOST`
- **Special draining behavior**: External state stays `ACTIVE` during gateway draining
- State change listeners and history tracking for debugging
- **25 unit tests with 100% statement coverage**

**Key Features**:
- `DRAINING_RECONNECTING` internal state reports as `ACTIVE` externally
- State transition validation prevents invalid state changes
- Event-driven architecture with listener support
- State history tracking (last 50 changes) prevents memory leaks
- Helper methods: `isActive()`, `isConnecting()`, `isReconnecting()`, `isDraining()`, etc.

**Success Criteria**: ✅ All state machine tests pass + all characterization tests still pass

### Phase 2: MessageHandler 🚧 IN PROGRESS
**Goal**: Separate message handling logic from connection management

**Deliverables**:
- `MessageHandler` class in `message-handler.ts`
- Separate handlers for setup phase vs active phase
- Clean method separation for different message types
- Request processing logic extracted into focused methods

**Testing Strategy**:
```typescript
describe('MessageHandler', () => {
  test('setup phase messages handled correctly')
  test('active phase messages handled correctly') 
  test('gateway executor requests processed correctly')
  test('heartbeat messages handled')
  test('draining messages trigger correct state transitions')
  test('malformed messages rejected appropriately')
})

describe('Message Integration', () => {
  test('mock server can send all message types')
  test('request/response cycle works end-to-end')
  test('lease extension works correctly')
  test('worker heartbeat/gateway heartbeat cycle')
})
```

**Success Criteria**: All existing tests pass + message handler unit tests pass

### Phase 3: WebSocketManager
**Goal**: Separate low-level WebSocket management from business logic

**Deliverables**:
- `WebSocketManager` class in `websocket-manager.ts`
- Handle WebSocket lifecycle (connect, disconnect, send, error handling)
- Emit events for connection state changes
- Manage heartbeat and keep-alive functionality
- Abstract away WebSocket specifics from main class

**Testing Strategy**:
```typescript
describe('WebSocketManager', () => {
  test('connection establishment with retries')
  test('connection cleanup on errors')
  test('heartbeat mechanism works correctly')
  test('message sending queues correctly when disconnected')
  test('connection timeout handling')
  test('WebSocket event handling (open, close, error, message)')
})

describe('Network Resilience', () => {
  test('handles sudden connection drops')
  test('handles slow network responses')
  test('handles invalid server responses')
  test('handles connection refused scenarios')
})
```

**Success Criteria**: All existing tests pass + WebSocket manager tests pass + network resilience tests pass

### Phase 4: ConnectLogger
**Goal**: Replace scattered debug calls with structured logging

**Deliverables**:
- `ConnectLogger` class in `logger.ts`
- Log levels: `ERROR`, `WARN`, `INFO`, `DEBUG`
- Structured logging with connection context
- Clear separation between connection events, state changes, and errors
- User-controllable logging without console spam

**Testing Strategy**:
```typescript
describe('ConnectLogger', () => {
  test('logs are structured and parseable')
  test('different log levels work correctly')
  test('connection context included in all logs')
  test('sensitive data (keys, tokens) is redacted')
  test('log volume is reasonable (no spam)')
  test('can be disabled completely for production')
})

describe('Logging Integration', () => {
  test('connection lifecycle produces expected log sequence')
  test('error scenarios produce helpful error logs')
  test('debug logs provide sufficient troubleshooting info')
})
```

**Success Criteria**: All existing tests pass + logging tests pass + manual verification of log output quality

### Phase 5: Main Class Refactor
**Goal**: Simplify main `WebSocketWorkerConnection` class using composition

**Deliverables**:
- Refactor `WebSocketWorkerConnection` to use extracted classes
- Reduce class to coordination logic only
- Clean up error handling patterns
- Simplify connection retry logic using state machine
- **Maintain exact same public API**

**Testing Strategy**:
```typescript
describe('WebSocketWorkerConnection Refactored', () => {
  test('public API unchanged')
  test('all configuration options still work')
  test('error types and messages unchanged')
  test('performance characteristics maintained')
  test('memory usage patterns unchanged')
})

describe('Behavioral Regression Tests', () => {
  test('all characterization tests still pass')
  test('timing behavior unchanged (no new delays)')
  test('retry backoff behavior identical')
  test('connection pooling behavior unchanged')
})
```

**Success Criteria**: ALL previous tests pass + new integration tests pass

### Phase 6: Comprehensive Testing
**Goal**: Ensure robust test coverage for all scenarios

**Deliverables**:
- Edge case tests for complex scenarios
- Performance benchmarks  
- Load testing capabilities
- Chaos testing (random failures)
- **>95% code coverage**

**Testing Strategy**:
```typescript
describe('Real-world Scenarios', () => {
  test('gateway version upgrade during operation')
  test('multiple concurrent function executions')
  test('long-running functions with lease extensions')
  test('rapid connect/disconnect cycles')
  test('memory pressure scenarios')
  test('authentication key rotation')
  test('network partition and recovery')
})

describe('Performance Tests', () => {
  test('connection establishment time < 2s')
  test('function execution latency < 100ms overhead')
  test('memory usage stays within bounds')
  test('handles 100+ concurrent connections')
})
```

**Success Criteria**: Achieve >95% code coverage + all performance benchmarks pass

## Testing Strategy

### Test Infrastructure

#### MockWebSocketServer
```typescript
class MockWebSocketServer {
  // Simulate all gateway message types
  sendGatewayHello()
  sendConnectionReady()
  sendExecutorRequest() 
  sendDrainingMessage()
  sendHeartbeat()
  
  // Simulate network conditions
  simulateLatency(ms: number)
  simulateConnectionDrop()
  simulateSlowResponse()
  
  // Test utilities
  getReceivedMessages()
  waitForConnection()
  assertMessageReceived(type: string)
}
```

#### MockHTTPServer
```typescript
class MockHTTPServer {
  // Simulate Inngest API endpoints
  handleStartRequest()
  handleFlushRequest()
  
  // Simulate various response scenarios
  simulateAuthFailure()
  simulateRateLimiting()
  simulateServerError()
  
  // Test verification
  getRequestHistory()
  assertEndpointCalled(endpoint: string)
}
```

#### ConnectionTestHarness
```typescript
class ConnectionTestHarness {
  // Coordinate complex test scenarios
  async simulateGatewayDraining()
  async simulateNetworkPartition()
  async simulateHighLoad()
  
  // State verification
  assertConnectionState(expected: ConnectionState)
  assertExternalStateRemains(state: ConnectionState)
  waitForStateTransition(to: ConnectionState)
  
  // Performance measurement
  measureConnectionTime()
  measureThroughput()
  measureMemoryUsage()
}
```

### Test Categories

1. **Unit Tests**: Each extracted class independently tested
2. **Integration Tests**: Full connection lifecycle with mock servers
3. **Characterization Tests**: Capture current behavior before refactoring
4. **Error Scenario Tests**: Network failures, auth failures, timeout handling
5. **Concurrency Tests**: Multiple simultaneous connections and requests
6. **Performance Tests**: Connection establishment time, throughput benchmarks
7. **Chaos Tests**: Random failures and edge cases

### Test Commands
```bash
# Run specific test suites
npm test -- --testPathPattern="connect"
npm test -- --testNamePattern="characterization" 
npm test -- --testNamePattern="state-machine"

# Run performance tests
npm run test:performance

# Run with coverage
npm test -- --coverage --collectCoverageFrom="src/components/connect/**/*.ts"
```

## State Machine Design

### Connection States

```typescript
enum ConnectionState {
  /**
   * Initial state when establishing connection to Inngest gateway.
   * WebSocket may be connecting, authenticating, or waiting for gateway ready signal.
   */
  CONNECTING = "CONNECTING",
  
  /**
   * Connection is established and ready to receive and execute function requests.
   * This is the normal operational state.
   */
  ACTIVE = "ACTIVE",
  
  /**
   * Connection was lost or failed - attempting to reconnect with exponential backoff.
   * No function requests will be processed until connection is restored.
   */
  RECONNECTING = "RECONNECTING",
  
  /**
   * Internal state during gateway-initiated draining process.
   * Externally reports as ACTIVE to maintain seamless operation while establishing new connection.
   * Gateway requested connection drain - establishing new connection while keeping current one active.
   */
  DRAINING_RECONNECTING = "DRAINING_RECONNECTING",
  
  /**
   * User requested graceful shutdown - cleaning up resources and closing connection.
   * No reconnection attempts will be made.
   */
  CLOSING = "CLOSING",
  
  /**
   * Connection fully closed and all resources cleaned up.
   * Terminal state - connection object should be discarded.
   */
  CLOSED = "CLOSED",
}
```

### Connection Events

```typescript
type ConnectionEvent = 
  | 'CONNECT_REQUESTED'     // Client initiates connection attempt or retry
  | 'WEBSOCKET_OPEN'        // WebSocket connection successfully opened
  | 'AUTH_SUCCESS'          // Authentication with Inngest API succeeded
  | 'AUTH_FAILED'           // Authentication with Inngest API failed
  | 'GATEWAY_READY'         // Gateway sent connection ready message, can now handle requests
  | 'DRAINING_REQUESTED'    // Gateway sends draining message (preparing to close connection gracefully)
  | 'NEW_CONNECTION_READY'  // New connection established during draining or after reconnect
  | 'ERROR_OCCURRED'        // Network error, WebSocket error, or other recoverable error
  | 'SHUTDOWN_REQUESTED'    // Client requests graceful shutdown (user calls close() or shutdown signal)
  | 'CONNECTION_LOST'       // WebSocket connection was lost unexpectedly
  | 'RECONNECT_STARTED';    // Beginning reconnection process after error
```

### Key State Transitions

1. **Initial Connection**: `CONNECTING` → (WEBSOCKET_OPEN, AUTH_SUCCESS) → (GATEWAY_READY) → `ACTIVE`
2. **Error Recovery**: `ACTIVE` → (ERROR_OCCURRED) → `RECONNECTING` → (CONNECT_REQUESTED) → `CONNECTING` → `ACTIVE`
3. **Gateway Draining**: `ACTIVE` → (DRAINING_REQUESTED) → `DRAINING_RECONNECTING` → (NEW_CONNECTION_READY) → `ACTIVE`
4. **Graceful Shutdown**: Any State → (SHUTDOWN_REQUESTED) → `CLOSING` → `CLOSED`

### Special Behaviors

- **External State Mapping**: `DRAINING_RECONNECTING` reports as `ACTIVE` externally
- **Terminal State**: `CLOSED` has no transitions out
- **Reconnection Prevention**: `CLOSING`/`CLOSED` states prevent reconnection attempts
- **State History**: Last 50 state changes tracked for debugging

## Backward Compatibility

### Public API Preservation
- **Exact same public interface**: All existing methods, properties, and events
- **Same error behavior**: Error types, messages, and timing
- **Same configuration options**: All current options supported
- **Same performance characteristics**: No regression in connection speed or memory usage

### Migration Strategy
- **Incremental refactoring**: Each phase maintains full backward compatibility
- **Comprehensive regression testing**: Characterization tests ensure no behavior changes
- **Fallback mechanisms**: Ability to revert changes if issues are discovered

## Success Metrics

### Code Quality
- **Single Responsibility**: Each class has one clear purpose
- **High Cohesion**: Related functionality grouped together
- **Low Coupling**: Minimal dependencies between components
- **Comprehensive Documentation**: Clear APIs and usage patterns

### Testing Coverage
- **>95% statement coverage**: Ensure all code paths are tested
- **>90% branch coverage**: Test all conditional logic
- **>90% function coverage**: Test all public and private methods
- **100% critical path coverage**: All user-facing functionality tested

### Performance Benchmarks
- **Connection establishment**: < 2 seconds in normal conditions
- **Function execution overhead**: < 100ms additional latency
- **Memory usage**: No leaks, bounded growth
- **Concurrent connections**: Handle 100+ simultaneous connections

### Reliability Metrics
- **Zero regressions**: All existing functionality preserved
- **Improved error recovery**: Better handling of edge cases
- **Enhanced observability**: Clearer logs for debugging
- **Maintainable codebase**: Easier to add features and fix bugs

## Risk Mitigation

### Technical Risks
1. **Breaking existing behavior**: Mitigated by comprehensive characterization tests
2. **Performance regression**: Mitigated by benchmarking before/after each phase
3. **Increased complexity**: Mitigated by clear interfaces and documentation
4. **Test maintenance burden**: Mitigated by focused unit tests and mock infrastructure

### Process Risks
1. **Large changeset**: Mitigated by incremental approach with separate commits per phase
2. **Merge conflicts**: Mitigated by frequent integration and communication
3. **Timeline pressure**: Mitigated by clear phase boundaries and success criteria

## Development Guidelines

### Code Standards
- **TypeScript strict mode**: All new code uses strict type checking
- **ESLint compliance**: Follow existing linting rules
- **Comprehensive JSDoc**: Document all public APIs and complex logic
- **Error handling**: Proper error types and handling at all levels

### Testing Standards
- **Test-first approach**: Write tests before implementation where possible
- **Clear test names**: Describe what behavior is being tested
- **Arrange-Act-Assert**: Structure tests clearly
- **Mock external dependencies**: Use test doubles for reliability

### Git Workflow
- **One phase per commit**: Each major milestone gets its own commit
- **Descriptive commit messages**: Include context and reasoning
- **Clean commit history**: Squash work-in-progress commits
- **Passing tests always**: Never commit with failing tests

This specification provides a comprehensive roadmap for improving the connect component while maintaining reliability and backward compatibility.