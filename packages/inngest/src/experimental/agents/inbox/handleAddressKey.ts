/**
 * @module
 * The key a thread handle carries its agent's address under. A leaf module, so
 * the thread code can use it without importing `reports.ts`, which imports the
 * `tool` namespace and would close an import cycle through `mcp.ts`.
 */

/**
 * The key a thread handle carries its agent's address under, so a report can
 * be routed to it. Present on `agent.thread(key)`, `me`, the handle `start()`
 * returns and `msg.from`.
 */
export const handleAddressKey: unique symbol = Symbol.for(
  "inngest.agents.handleAddress",
);
