# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Overview

This is the `eslint-plugin-inngest` package - an ESLint plugin that provides linting rules specifically for Inngest function development. It helps developers avoid common mistakes and follow best practices when writing Inngest functions.

## Development Workflow

### Setup
```bash
# From the eslint-plugin directory
cd packages/eslint-plugin/
pnpm install
```

### Common Commands

```bash
pnpm test             # Run Jest tests for ESLint rules
pnpm build            # Build TypeScript to dist/
```

### Testing Strategy

- **Rule Testing**: Jest tests for each ESLint rule
- **AST Testing**: Tests abstract syntax tree parsing and rule logic
- Uses Jest for testing rule behavior and edge cases

## Architecture

### Key Concepts
- **ESLint Rules**: Custom rules for Inngest-specific patterns
- **AST Analysis**: Analyzes JavaScript/TypeScript code structure
- **Best Practices**: Enforces Inngest function development patterns

### Package Structure
- `src/index.ts` - Main plugin export and rule registration
- `src/rules/` - Individual ESLint rule implementations
- `src/configs/` - Predefined ESLint configurations
  - `recommended.ts` - Recommended rule set

### Current Rules
- `await-inngest-send` - Ensures `inngest.send()` calls are awaited
- `no-nested-steps` - Prevents nested step function calls
- `no-variable-mutation-in-step` - Prevents variable mutation within steps

### Rule Structure
Each rule follows ESLint's rule format:
- Rule definition with metadata
- AST visitor patterns
- Error reporting and suggestions
- Comprehensive test coverage

## ESLint Integration

This package integrates with ESLint tooling:
- Provides recommended configuration preset
- Exports individual rules for custom configurations
- Follows ESLint plugin conventions and patterns

## Testing Rules

Rule testing follows ESLint's testing patterns:
- Uses `ESLintUtils.RuleTester` for rule validation
- Tests valid and invalid code cases
- Verifies error messages and suggested fixes