# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `@inngest/middleware-validation` package - an Inngest middleware that provides input validation capabilities for Inngest functions. It validates event data and function inputs using schema validation libraries before function execution.

## Development Workflow

### Setup
```bash
# From the middleware-validation package directory
cd packages/middleware-validation/
pnpm install
```

### Common Commands

```bash
pnpm test             # Run Jest tests
pnpm build            # Full build: clean + TypeScript compilation
pnpm build:clean      # Remove dist directory  
pnpm build:tsc        # TypeScript compilation only
```

### Testing Strategy

- **Unit tests**: Jest (`pnpm test`)
- **Middleware testing**: Tests validation logic and error handling
- Uses `ts-jest` for TypeScript support

## Architecture

### Key Concepts
- **Input Validation**: Validates incoming event data and function parameters
- **Schema Support**: Works with popular validation libraries (Zod, Joi, etc.)
- **Middleware Pattern**: Integrates seamlessly with Inngest's middleware system
- **Error Handling**: Provides clear validation error messages

### Package Structure
- `src/index.ts` - Main middleware export
- `src/middleware.ts` - Core validation middleware implementation
- `src/middleware.test.ts` - Comprehensive middleware tests

## Validation Strategy

The middleware intercepts function calls to:
- Validate event data against provided schemas
- Validate function input parameters
- Return descriptive error messages for validation failures
- Allow functions to proceed only with valid data

## Integration with Inngest

Designed as standard Inngest middleware that runs before function execution:
- Plugs into Inngest's middleware pipeline
- Provides type-safe validation
- Maintains compatibility with Inngest's execution model

## Schema Library Support

Built to work with popular JavaScript validation libraries:
- Flexible schema interface
- Library-agnostic validation approach
- Extensible for custom validation logic