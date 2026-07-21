# Agent Guidance — `src/components/`

Guidance for the core client (`Inngest.ts`), comm handler, and execution code.

## Resolve env vars lazily, never at construction time

**Do not read env vars in the `Inngest` constructor and cache the result.** Some
runtimes don't expose env vars as global `process.env` at construction:

- Node serverless usually has `process.env` available.
- Edge / non-Node runtimes (Cloudflare Workers-style APIs, etc.) pass env vars as
  per-request bindings, and there may be no real `process` at all. The client is
  constructed once, then `setEnvVars()` populates `this._env` as each request
  comes in.

If you resolve a setting from an env var in the constructor, edge users will
silently never pick up that env var — it was empty when the constructor ran.

**Instead, resolve on access via a getter that reads `this._env`.** Follow
long-standing getters in `Inngest.ts`: `get mode()` (a boolean toggle read via
`parseAsBoolean(this._env[envKeys.InngestDevMode])`), or `get eventKey()` /
`get signingKey()` (the `this.options.x || this._env[envKeys.X]` precedence
one-liner). Read `this._env[envKeys.Foo]` every time the value is needed,
applying precedence (explicit option > env var > default) inside the getter.

This is why the `setEnvVars()` uses exist — honor them by reading
`this._env` late, not by snapshotting it early.
