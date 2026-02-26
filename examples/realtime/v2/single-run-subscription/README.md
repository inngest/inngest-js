# Realtime V2: declarative channels with the core SDK

This example demonstrates the new realtime API built into the core `inngest` package. No `@inngest/realtime` middleware needed.

## What it shows

- **Declarative channels** with `realtime.channel()` and typed topics
- **Non-durable publish** via `publish(topicRef, data)` in the function context
- **Durable publish** via `step.realtime.publish(id, topicRef, data)`
- **Server-side subscribe** via `inngest.realtime.subscribe()`
- **Shared channel definitions** imported by both publisher and subscriber

## Setup

```bash
npm install
```

To test against local inngest package changes (before publishing):

```bash
# From packages/inngest/
pnpm build && pnpm local:pack

# From this directory
npm install --no-save ../../../../packages/inngest/inngest.tgz
```

## Run

```bash
npm run dev
```

This starts the Inngest dev server and the example app. After syncing, it sends 5 upload events and subscribes to status updates from the first upload only.
