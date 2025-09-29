# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `@inngest/realtime` package - a React-focused library that provides real-time capabilities for Inngest applications. It enables real-time subscriptions, channel management, and React hooks for building interactive applications with live data updates.

## Development Workflow

### Setup
```bash
# From the realtime package directory
cd packages/realtime/
pnpm install
```

### Common Commands

```bash
pnpm test             # Run Jest tests
pnpm build            # Build TypeScript to dist/
pnpm pack             # Create inngest-realtime.tgz for local testing
```

### Testing Strategy

- **Unit tests**: Jest (`pnpm test`)
- **React testing**: Tests React hooks and components
- Uses `ts-jest` for TypeScript support

## Architecture

### Key Concepts
- **Real-time Subscriptions**: Live data streaming capabilities
- **Channel Management**: Topic-based message routing
- **React Integration**: Custom hooks for React applications
- **Token-based Authentication**: Secure subscription management

### Package Structure
- `src/index.ts` - Main exports and core functionality
- `src/hooks.ts` - React hooks for real-time features
- `src/channel.ts` - Channel management logic
- `src/topic.ts` - Topic-based messaging
- `src/api.ts` - API integration layer
- `src/middleware.ts` - Inngest middleware integration
- `src/subscribe/` - Subscription management utilities

### Exports
The package provides two main export paths:
- `@inngest/realtime` - Core real-time functionality
- `@inngest/realtime/hooks` - React hooks specifically

## React Integration

This package is designed specifically for React applications (requires React >=18.0.0):
- Provides React hooks for real-time subscriptions
- Manages WebSocket connections and state
- Integrates with React's concurrent features

## Dependencies

- **Peer Dependencies**: React >=18.0.0 (required)
- **Core Dependencies**: inngest, zod for validation, debug for logging
- **Schema Validation**: Supports both Zod and Valibot for schema validation

## Integration with Inngest

Works as middleware and extension to the main Inngest package, providing real-time capabilities that complement Inngest's event-driven architecture.