# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the **core `inngest` package** - the main TypeScript/JavaScript SDK for Inngest, a platform for building reliable, event-driven systems with durable execution. This package provides the complete SDK including framework adapters, step functions, event handling, middleware system, and execution engine.

**Key Purpose**: Enable developers to build serverless background jobs, scheduled functions, step functions, and event-driven workflows that run reliably across any platform with built-in retries, observability, and durable execution.

## Development Workflow

### Setup and Prerequisites
```bash
# Navigate to the main package
cd packages/inngest/

# Install dependencies (pnpm is required - enforced by preinstall hook)
pnpm install

# Start development mode (builds + lints + watches)
pnpm dev
```

### Essential Commands

**Development Commands:**
```bash
pnpm dev                 # Watch mode: concurrent build + lint on changes
pnpm dev:build          # Watch mode: build only
pnpm dev:lint           # Watch mode: lint only

pnpm build              # Full production build (TypeScript + tsdown bundling)
pnpm lint               # Run Biome linting (NOT ESLint - this is critical)

# Build pipeline details:
pnpm prebuild           # Generate version file from git
pnpm pb:version         # Generate src/version.ts from package.json
```

**Testing Commands:**
```bash
pnpm test               # Run Vitest unit tests
pnpm test --watch       # Watch mode testing
pnpm test:examples      # Test function examples in src/test/functions/
pnpm test:types         # TypeScript compilation check
pnpm test:dist          # Verify built .d.ts files
pnpm test:deps          # Check dependency compatibility
pnpm test:composite     # End-to-end test with packaged version
```

**Integration Testing:**
```bash
pnpm itest <example>    # Run integration tests against live examples
pnpm itest framework-nextjs-app-router  # Example usage
```

**Local Development & Testing:**
```bash
pnpm local:pack         # Create inngest.tgz for local testing
pnpm dev:example        # Interactive example runner
pnpm bench              # Run performance benchmarks
```

**Protocol Buffer Generation:**
```bash
pnpm proto              # Generate TypeScript from .proto files
```

### Code Quality Standards

- **Linting**: Uses **Biome** (NOT ESLint) - this is a critical difference from other packages
- **Formatting**: Biome handles automatic formatting
- **TypeScript**: Strict mode enabled, requires TypeScript 5.8+
- **Testing**: Vitest with comprehensive coverage requirements
- **Build**: tsdown for optimized CommonJS/ESM dual builds

**Pre-commit checklist:**
1. `pnpm lint` must pass (Biome)
2. `pnpm test` must pass (Vitest)
3. `pnpm test:types` must pass (TypeScript compilation)
4. `pnpm build` must succeed

## Architecture Deep Dive

### Core Architectural Principles

1. **Durable Execution**: Functions resume from where they left off using step memoization
2. **Event-Driven**: Everything is triggered by events with automatic routing
3. **Framework Agnostic**: Single codebase supports 15+ frameworks via adapters
4. **Type Safety**: Full TypeScript support with advanced type inference
5. **Middleware System**: Extensible pipeline for cross-cutting concerns

### Package Structure & Key Directories

```
src/
├── components/           # Core SDK components
│   ├── Inngest.ts       # Main client class
│   ├── InngestFunction.ts # Function wrapper with execution logic
│   ├── InngestStepTools.ts # Step utilities (step.run, step.sleep, etc.)
│   ├── InngestCommHandler.ts # HTTP request handler
│   ├── InngestMiddleware.ts # Middleware system
│   ├── EventSchemas.ts  # Event type system
│   ├── execution/       # Execution engines
│   │   ├── v0.ts       # Legacy execution (pre-steps)
│   │   ├── v1.ts       # Original step execution
│   │   ├── v2.ts       # Current execution with improvements
│   │   └── InngestExecution.ts # Execution interface
│   └── connect/         # Inngest Connect (streaming/realtime)
├── helpers/             # Utility functions
│   ├── consts.ts       # Constants, env vars, headers
│   ├── env.ts          # Environment detection & configuration
│   ├── errors.ts       # Error handling utilities
│   ├── functions.ts    # Function processing utilities
│   ├── net.ts          # Network utilities, signing
│   ├── strings.ts      # String processing, hashing
│   ├── types.ts        # Advanced TypeScript utilities
│   └── temporal.ts     # Date/time utilities
├── middleware/          # Built-in middleware
│   ├── logger.ts       # Logging middleware
│   └── dependencyInjection.ts # DI middleware
├── api/                # API schemas and validation
├── test/functions/     # Example functions for testing
└── Framework adapters: # One file per framework
    ├── next.ts         # Next.js (App Router + Pages Router)
    ├── express.ts      # Express.js
    ├── fastify.ts      # Fastify
    ├── sveltekit.ts    # SvelteKit
    ├── cloudflare.ts   # Cloudflare Workers
    ├── lambda.ts       # AWS Lambda
    ├── vercel.ts       # Vercel Functions
    └── ... (15+ total frameworks)
```

### Core Components Deep Dive

#### 1. Inngest Client (`src/components/Inngest.ts`)
**Purpose**: Main SDK entry point for creating functions, sending events, and configuration.

**Key Capabilities:**
- Event sending with automatic retries
- Function creation with type inference
- Middleware registration
- Environment detection (dev vs prod)
- Event schema management

**Critical Implementation Details:**
- Handles dual environments (dev server vs production)
- Manages event key validation and signing
- Provides type-safe event APIs when schemas are provided
- Integrates with `@inngest/ai` for AI model support

#### 2. InngestFunction (`src/components/InngestFunction.ts`)
**Purpose**: Wraps user functions with execution logic, step management, and retry handling.

**Key Features:**
- Function configuration (triggers, concurrency, retries)
- Step execution and memoization
- Failure handling and error boundaries
- Middleware integration
- Multiple execution version support

**Execution Versions:**
- `v0`: Legacy (pre-step functions)
- `v1`: Original step implementation  
- `v2`: Current with performance improvements

#### 3. Step Tools (`src/components/InngestStepTools.ts`)
**Purpose**: Provides the `step` object with durable execution primitives.

**Available Steps:**
```typescript
step.run(id, fn)           // Durable function execution
step.sleep(id, duration)   // Durable sleep/delay
step.sleepUntil(id, date) // Sleep until specific time
step.waitForEvent(id, opts) // Wait for external events
step.sendEvent(id, events) // Send events durably
step.invoke(id, function)  // Invoke other functions
step.ai.wrap(model)        // AI model integration
```

**Critical Concepts:**
- Each step requires a unique ID for memoization
- Steps are serializable and resumable
- Failed steps automatically retry
- Step outputs are memoized across retries

#### 4. Communication Handler (`src/components/InngestCommHandler.ts`)
**Purpose**: HTTP request handler that processes Inngest requests across frameworks.

**Key Responsibilities:**
- Request authentication and signature verification
- Function registration and introspection
- Event parsing and validation
- Response formatting and streaming
- Error handling and reporting

#### 5. Middleware System (`src/components/InngestMiddleware.ts`)
**Purpose**: Extensible pipeline for cross-cutting concerns.

**Middleware Hooks:**
```typescript
onSendEvent()        // Before/after sending events
onFunctionRun()      // Before/after function execution  
onStepRun()         // Before/after individual steps
transformInput()     // Modify function inputs
transformOutput()    // Modify function outputs
```

### Framework Adapter System

**Architecture**: Each framework gets its own adapter file (`{framework}.ts`) that exports a `serve()` function.

**Common Pattern:**
```typescript
export const serve = (
  inngest: Inngest,
  functions: InngestFunction[],
  options?: ServeOptions
) => {
  // Framework-specific handler that calls InngestCommHandler
  return new InngestCommHandler({
    frameworkName: "framework-name",
    fetch: frameworkSpecificFetch,
    // Framework-specific configurations
  }).createHandler(inngest, functions, options);
};
```

**Supported Frameworks:**
- **Server-side**: Next.js, Express, Fastify, Koa, H3, Nuxt, Hono, Node.js
- **Serverless**: AWS Lambda, Vercel, Netlify, Cloudflare Workers
- **Edge**: Deno (Fresh), Bun, DigitalOcean
- **Full-stack**: SvelteKit, Remix, RedwoodJS, Astro

### Event System & Type Safety

#### Event Schemas (`src/components/EventSchemas.ts`)
**Purpose**: Provides compile-time type safety for events.

**Usage Patterns:**
```typescript
// Basic usage
const inngest = new Inngest({ id: "my-app" });

// With type safety
const inngest = new Inngest({
  id: "my-app",
  schemas: new EventSchemas().fromRecord<{
    "user/created": { data: { userId: string; email: string } };
    "user/deleted": { data: { userId: string } };
  }>()
});
```

#### Event Flow:
1. **Event Creation**: `inngest.send()` validates against schemas
2. **Event Routing**: Inngest platform routes to matching functions
3. **Function Triggers**: Functions receive typed event data
4. **Step Execution**: Steps can send additional events

### Execution Engine Details

#### Step Memoization Process:
1. **Step Registration**: Function declares steps during "dry run"
2. **State Retrieval**: Executor provides existing step results
3. **Selective Execution**: Only new/failed steps execute
4. **State Persistence**: New step results saved for future runs

#### Execution Context (`Context`):
```typescript
{
  event: EventPayload,     // Triggering event data
  events: EventPayload[],  // Batch of events (if applicable)
  runId: string,          // Unique execution identifier
  step: StepTools,        // Step execution utilities
  group: GroupTools,      // Tools for grouping/coordinating steps (e.g. group.parallel())
  attempt: number,        // Retry attempt number
  logger: Logger          // Structured logging
}
```

### Environment & Configuration

#### Environment Detection (`src/helpers/env.ts`):
- **Development Mode**: Uses local dev server for immediate feedback
- **Production Mode**: Connects to Inngest Cloud platform
- **Framework Detection**: Automatically detects runtime environment

#### Critical Environment Variables:
```bash
# Authentication
INNGEST_SIGNING_KEY          # Production signing key
INNGEST_EVENT_KEY           # Event authentication key

# Development
INNGEST_DEV=1               # Force development mode
INNGEST_BASE_URL            # Custom Inngest endpoint

# Configuration  
INNGEST_LOG_LEVEL           # Logging verbosity
INNGEST_STREAMING=1         # Enable streaming responses
```

### Build System & Distribution

#### TypeScript Configuration:
- **`tsconfig.json`**: Development configuration
- **`tsconfig.build.json`**: Production build (excludes tests)
- **`tsconfig.types.json`**: Type checking only

#### Build Pipeline (`tsdown`):
1. **TypeScript Compilation**: Source to JavaScript
2. **Dual Format**: CommonJS + ESM outputs
3. **Declaration Files**: TypeScript definitions
4. **Framework Splitting**: Separate entry points for each framework
5. **Source Maps**: For debugging support

#### Package Exports:
```json
{
  ".": "Main SDK",
  "./next": "Next.js adapter", 
  "./express": "Express.js adapter",
  "./types": "Type definitions only",
  // ... 15+ framework-specific exports
}
```

### Testing Strategy

#### Test Types:
1. **Unit Tests**: Component isolation (Vitest)
2. **Integration Tests**: Live examples with real functions
3. **Type Tests**: TypeScript compilation verification
4. **Composite Tests**: End-to-end with packaged builds
5. **Example Functions**: Comprehensive test functions in `src/test/functions/`

#### Vitest Configuration:
- **Environment**: Node.js
- **Coverage**: V8 coverage provider
- **Parallelism**: File-level parallelism enabled
- **TypeScript**: Full type checking during tests

#### Example Functions (`src/test/functions/`):
Real Inngest functions used for testing:
- `hello-world/`: Basic function execution
- `parallel-work/`: Concurrent step execution
- `step-invoke/`: Function-to-function calls
- `handling-step-errors/`: Error handling patterns

### Advanced Features

#### AI Integration:
- Re-exports `@inngest/ai` for seamless AI model usage
- Provides `step.ai.wrap()` for durable AI operations
- Supports OpenAI, Anthropic, Google, and other providers

#### Observability:
- **OpenTelemetry**: Built-in tracing support
- **Structured Logging**: JSON-formatted logs with context
- **Server Timing**: Performance metrics in HTTP headers
- **Debug Mode**: Detailed execution logging

#### Connect (Realtime):
- Streaming execution results
- Real-time function monitoring  
- Live step updates
- WebSocket-based communication

### Security Model

#### Request Authentication:
1. **Signature Verification**: All requests signed with HMAC
2. **Key Rotation**: Support for primary + fallback keys
3. **Timestamp Validation**: Prevents replay attacks
4. **Webhook Security**: Standardized webhook authentication

#### Data Security:
- **No Secrets in Logs**: Automatic secret redaction
- **Secure Headers**: Proper CORS and security headers
- **Input Validation**: Zod schemas for all inputs

### Common Development Patterns

#### Creating Functions:
```typescript
export const myFunction = inngest.createFunction(
  {
    id: "my-function",
    concurrency: { limit: 10 },
    retries: { attempts: 3 },
    triggers: [{ event: "user/created" }],
  },
  async ({ event, step }) => {
    // Step 1: Send welcome email
    const emailResult = await step.run("send-welcome-email", async () => {
      return await sendEmail(event.data.email);
    });

    // Step 2: Wait for user activation
    await step.waitForEvent("wait-for-activation", {
      event: "user/activated",
      match: "data.userId",
      timeout: "7d"
    });

    // Step 3: Send follow-up
    await step.run("send-followup", async () => {
      return await sendFollowUpEmail(event.data.email);
    });
  }
);
```

#### Error Handling:
```typescript
import { NonRetriableError, RetryAfterError } from "inngest";

await step.run("api-call", async () => {
  try {
    return await externalAPI.call();
  } catch (error) {
    if (error.status === 400) {
      // Don't retry client errors
      throw new NonRetriableError("Invalid request", { cause: error });
    }
    if (error.status === 429) {
      // Retry after specific time
      throw new RetryAfterError("Rate limited", "30s", { cause: error });
    }
    throw error; // Default retry behavior
  }
});
```

### Performance Considerations

#### Step Design:
- **Idempotent Steps**: Steps should be safe to run multiple times
- **Granular Steps**: Break work into logical, resumable units
- **Minimize State**: Keep step inputs/outputs small
- **Batch Operations**: Group related work when possible

#### Memory Management:
- **Step Memoization**: Cached results consume memory during execution
- **Large Payloads**: Consider external storage for large data
- **Streaming**: Use streaming for large responses

### Debugging & Troubleshooting

#### Local Development:
1. **Dev Server**: Automatic function registration and testing
2. **Verbose Logging**: Set `INNGEST_LOG_LEVEL=debug`
3. **Step Inspection**: Use Inngest dashboard to view step execution
4. **Hot Reload**: Changes automatically reflected in dev server

#### Common Issues:
- **Step ID Conflicts**: Ensure unique step IDs within functions
- **Serialization Errors**: Step arguments must be JSON-serializable
- **Signature Mismatches**: Verify signing keys and configuration
- **Framework Compatibility**: Check framework-specific requirements

#### File-Level Guidance:

**When modifying `src/components/Inngest.ts`:**
- Main client entry point - changes affect all SDK users
- Handle backward compatibility carefully
- Update type exports in `src/index.ts`

**When modifying `src/components/InngestFunction.ts`:**
- Core execution logic - test thoroughly with integration tests
- Consider impact on all execution versions (v0, v1, v2)
- Update middleware hooks if execution flow changes

**When adding framework adapters:**
- Follow existing patterns in other framework files
- Test with real framework applications
- Update package.json exports
- Add to tsdown.config.ts entry points

**When modifying step tools:**
- Ensure backward compatibility
- Test serialization/deserialization
- Verify idempotent behavior
- Update TypeScript definitions

This package is the foundation of the entire Inngest ecosystem - changes here impact all users and dependent packages. Always test thoroughly and consider backward compatibility.