# Realtime V2: across multiple channels

This Node.js example demonstrates first-class realtime in the core `inngest` SDK.

It shows:

- Declarative channels with `realtime.channel(...)`
- Publishing in a function via `publish(topicRef, data)`
- Subscribing from Node with `inngest.realtime.subscribe(...)`
- Streaming across both a global channel and a parameterized channel

## Setup

```bash
npm install
```

To test with local SDK changes:

```bash
# from packages/inngest
pnpm build && pnpm local:pack

# from this example directory
npm install --no-save ../../../packages/inngest/inngest.tgz
```

## Run

```bash
npm run dev
```

This starts:

- Inngest Dev Server (syncing `http://localhost:3000/api/inngest`)
- The local app server + subscriptions

After sync, the app sends periodic `app/post.like` events. You should see:

- `logs` messages from the `global` channel
- `updated` messages from `post:123`
