---
"inngest": patch
---

Fix declaration emit repeating the step tools and handler context in every exported function (~40 KB each). The object returned by `createStepTools` is now a named, exported `StepTools` interface, and `BaseContextWithTriggers` is now an exported interface instead of a type alias, so TypeScript can refer to both by name in emitted declarations. Both types are exported from the package entry. The runtime is unchanged.
