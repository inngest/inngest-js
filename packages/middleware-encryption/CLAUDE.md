# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `@inngest/middleware-encryption` package - an Inngest middleware that provides end-to-end encryption capabilities for Inngest functions. It allows encryption of event data and step outputs using various encryption strategies including AES and libSodium.

## Development Workflow

### Setup
```bash
# From the middleware-encryption package directory
cd packages/middleware-encryption/
pnpm install
```

### Common Commands

```bash
pnpm test             # Run Jest tests
pnpm build            # Full build: clean + TypeScript + copy files
pnpm build:clean      # Remove dist directory
pnpm build:tsc        # TypeScript compilation only
pnpm build:copy       # Copy package files to dist
pnpm pack             # Create inngest-middleware-encryption.tgz
```

### Build Process

This package has a unique build process that copies built files to a `dist/` directory and publishes from there (note `DIST_DIR=dist` in release script).

## Architecture

### Key Concepts
- **E2E Encryption**: Encrypts data before it leaves your application
- **Multiple Strategies**: Supports AES and libSodium encryption
- **Middleware Pattern**: Integrates with Inngest's middleware system
- **Manual Mode**: Provides manual encryption/decryption utilities

### Package Structure
- `src/index.ts` - Main middleware export
- `src/middleware.ts` - Core middleware implementation
- `src/manual.ts` - Manual encryption utilities
- `src/stages.ts` - Encryption pipeline stages
- `src/strategies/` - Different encryption implementations
  - `aes.ts` - AES encryption strategy
  - `libSodium.ts` - libSodium-based encryption
  - `legacy.ts` - Legacy encryption support

### Exports
The package provides multiple export paths:
- `@inngest/middleware-encryption` - Main middleware
- `@inngest/middleware-encryption/manual` - Manual encryption tools
- `@inngest/middleware-encryption/strategies/aes` - AES strategy
- `@inngest/middleware-encryption/strategies/libSodium` - libSodium strategy

## Security Considerations

This package handles sensitive encryption operations:
- Uses established cryptographic libraries (crypto-js, libsodium-wrappers)
- Implements secure key management patterns
- Provides multiple encryption strategies for different security needs

## Dependencies

- **Core Dependencies**: crypto-js, libsodium-wrappers for encryption
- **Peer Dependencies**: inngest >=3.0.0 (required)
- **Testing**: Uses Jest with fetch mocking for comprehensive testing

## Integration with Inngest

Designed as Inngest middleware that automatically encrypts/decrypts data as it flows through Inngest functions, providing transparent E2E encryption.