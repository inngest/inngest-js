# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `@inngest/test` package - a testing utility library that provides mocking and testing tools for Inngest functions. It enables developers to unit test their Inngest functions with proper mocking of step tools, events, and execution state.

## Development Workflow

### Setup
```bash
# From the test package directory
cd packages/test/
pnpm install
```

### Common Commands

```bash
pnpm test             # Run Vitest tests
pnpm build            # Clean build with TypeScript
pnpm build:clean      # Remove dist directory
pnpm build:tsc        # TypeScript compilation only
pnpm pack             # Create inngest-test.tgz for local testing
```

### Testing Strategy

- **Unit tests**: Vitest (`pnpm test`)
- Designed to be framework-agnostic for end users
- Supports Jest, Vitest, Bun test, Deno, and Chai

## Architecture

### Key Concepts
- **InngestTestEngine**: Main testing class that provides function execution and mocking
- **Framework Compatibility**: Designed to work with major testing frameworks
- **Step Mocking**: Mock individual steps within functions
- **Event Mocking**: Mock incoming event data
- **Spy Functions**: Testing-framework-compatible spies for step tools

### Core API
- `InngestTestEngine` - Primary testing interface
- `t.execute()` - Run entire function to completion
- `t.executeStep(stepId)` - Run function until specific step
- `mockCtx()` - Automatic context mocking helper

### Package Structure
- `src/InngestTestEngine.ts` - Main testing engine
- `src/InngestTestRun.ts` - Individual test run implementation
- `src/spy.ts` - Spy utilities (compatible with Jest/Vitest/etc.)
- `src/util.ts` - Testing utilities

## Usage Patterns

This package is designed for testing Inngest functions with patterns like:
- Mocking step outputs for different execution paths
- Testing individual steps in isolation
- Asserting on step tool usage and function state
- Event-driven function testing with custom event data

## Dependencies

- Requires `inngest@^4.0.0` as peer dependency
- Uses `tinyspy` for spy/mock functionality
- Generates unique IDs with `ulid`
