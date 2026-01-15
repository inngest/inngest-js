# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the official Inngest JavaScript/TypeScript SDK - a monorepo containing packages for building serverless event-driven systems, background jobs, and durable step functions. The SDK provides framework adapters for Next.js, Express, SvelteKit, and 15+ other frameworks.

## Development Workflow

### Setup
```bash
# Use pnpm (required, enforced by preinstall hook)
cd packages/inngest/
pnpm dev  # Installs deps, builds, lints, and watches for changes
```

### Common Commands

**Main development (in `packages/inngest/`):**
```bash
pnpm dev              # Watch mode: builds + lints on changes
pnpm test             # Run unit tests
pnpm test --watch     # Watch mode testing
pnpm build            # Build the package
pnpm lint             # Run Biome linting
pnpm local:pack       # Create inngest.tgz for local testing
pnpm dev:example      # Test with example projects
pnpm itest <example>  # Run integration tests against examples
```

**Root level commands:**
```bash
pnpm build            # Build all packages recursively
```

### Testing Strategy

1. **Unit tests**: Vitest (`pnpm test`)
2. **Integration tests**: `pnpm itest <example-name>` - tests against live examples
3. **Type tests**: `pnpm test:types` - TypeScript compilation checks
4. **Composite tests**: `pnpm test:composite` - full end-to-end with packaged version
5. **Example testing**: Comprehensive framework examples in `/examples/`

### Code Quality

- **Linting**: Biome (not ESLint) - run `pnpm lint`
- **Formatting**: Biome handles this automatically
- **TypeScript**: Strict configuration, requires TS 5.8+
- Always run `pnpm lint` before committing changes

## Architecture

### Monorepo Structure
- **`packages/inngest/`**: Main SDK package with framework adapters
- **`packages/test/`**: Testing utilities (`@inngest/test`)
- **`packages/ai/`**: AI integration package (`@inngest/ai`)
- **`packages/middleware-*/`**: Various middleware packages
- **`packages/realtime/`**: Real-time functionality
- **`packages/eslint-plugin/`**: ESLint plugin for Inngest

### Key SDK Concepts
- **Durable execution**: Step-based functions that persist state across invocations
- **Event-driven**: Functions triggered by events with automatic retries
- **Framework-agnostic**: Adapters for 15+ frameworks and platforms
- **Middleware system**: Extensible plugin architecture

### Framework Adapters
The SDK provides framework-specific adapters exported as subpaths:
- `inngest/next` - Next.js (App Router + Pages Router)
- `inngest/express` - Express.js
- `inngest/fastify` - Fastify
- `inngest/sveltekit` - SvelteKit
- `inngest/cloudflare` - Cloudflare Workers
- And many more (see package.json exports)

## Examples

The `/examples/` directory contains 20+ working examples:
- **Framework examples**: `framework-nextjs-app-router`, `framework-express`, etc.
- **Use case examples**: `realtime-*`, `step-ai/`, etc.
- **Middleware examples**: `middleware-e2e-encryption`, etc.

To test examples: `pnpm dev:example` and select from the list.

## Release Process

- **Changesets**: All releases managed through Changesets
- **Prerelease**: Add `prerelease/inngest` label to PRs for `pr-123` versions
- **Backports**: Add `backport v*.x` labels for legacy version releases
- **Publishing**: To npm

## Special Notes

- **pnpm required**: Enforced by preinstall hook
- **Node 20+**: Required for development
- **TypeScript 5.8+**: Strict peer dependency requirement
- **Framework peer deps**: All framework dependencies are optional peer deps
- **No ESLint**: Uses Biome instead for linting and formatting