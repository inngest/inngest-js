# Middleware architecture

## Hooks

The most complicated hook (by far) is `wrapStep`. It wraps every step, which necessitates promise chains.

## `MiddlewareManager`

`MiddlewareManager` is an abstraction layer between execution and middleware. It's sole purpose is to minimize polluting execution code with excessive middleware concerns.
