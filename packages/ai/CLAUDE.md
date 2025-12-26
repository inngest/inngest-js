# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `@inngest/ai` package - a TypeScript library that provides AI model adapters and utilities for use with Inngest functions. It enables seamless integration with various AI providers like OpenAI, Anthropic, Google Gemini, and others within Inngest step functions.

## Development Workflow

### Setup

```bash
# From the ai package directory
cd packages/ai/
pnpm install
```

### Common Commands

```bash
pnpm build            # Build TypeScript to dist/
pnpm test             # Run tests (if any)
pnpm release          # Build and publish to npm
```

### Code Quality

- **Linting**: Uses ESLint (unlike main inngest package which uses Biome)
- **TypeScript**: Strict configuration
- Always run `pnpm build` to verify compilation before committing

## Architecture

### Key Concepts

- **Model Adapters**: Standardized interfaces for different AI providers
- **Provider Support**: OpenAI, Anthropic (Claude), Google Gemini, Grok, DeepSeek
- **Type Safety**: Full TypeScript support with proper typing for each provider

### Package Structure

- `src/models/` - Provider-specific model implementations
- `src/adapters/` - Adapter interfaces and implementations
- `src/index.ts` - Main exports
- `src/env.ts` - Environment variable handling

### Exports

The package provides three main export paths:

- `@inngest/ai` - Main package exports
- `@inngest/ai/models` - Direct model access
- `@inngest/ai/adapters` - Adapter interfaces

## Integration with Inngest

This package is designed to work seamlessly with the main `inngest` package and is automatically re-exported from `inngest` via `export * from "@inngest/ai"`. When working on AI-related features, consider how they integrate with step functions and the broader Inngest ecosystem.
