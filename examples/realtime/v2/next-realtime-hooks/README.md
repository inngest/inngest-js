# Realtime V2 Next.js Hooks Example

This example shows the first-class Realtime v2 flow in a Next.js app using `useRealtime` and `getSubscriptionToken` from `inngest/react`.

It demonstrates:

- Shared, typed channel/topic definitions between publisher and subscriber
- Server-minted subscription tokens from a Next.js server action
- A client `useRealtime` subscription with `enabled`, buffering, and reset controls
- A long-running loop function that continuously publishes logs until cancelled

## Prerequisites

- Node.js 20+
- npm, pnpm, or yarn

## Install

```bash
cd examples/realtime/v2/next-realtime-hooks
npm install
```

## Run locally

1. Start the Next.js app:

```bash
npm run dev
```

The app runs at [http://localhost:3001](http://localhost:3001).

2. In a second terminal, start Inngest Dev Server and sync the Next handler:

```bash
npx inngest-cli@latest dev -u http://localhost:3001/api/inngest
```

3. Open the app and click `Start` to trigger the function loop. Click `Stop` to send the cancel signal.

## What to look for in the UI

- `Connection` and `Run` status from `useRealtime`
- Live message stream in `Output Events`
- `Fresh` vs `Latest` inspector panes
- `Latest (typed map)` view for topic-keyed message access
- `Buffer Interval (ms)` to batch incoming messages
- `Enabled/Disabled` toggle to pause/resume client subscription
- `Reset History` to clear retained messages

## How it works

- `app/page.tsx`: Client UI using `useRealtime({ channel, topics, token, bufferInterval, enabled })`
- `app/actions.ts`: Server actions for token minting and start/stop events
- `app/api/inngest/route.ts`: Inngest Next.js handler
- `inngest/channels.ts`: Declarative channel + typed topics
- `inngest/functions/helloWorld.ts`: Function publishes `logs` messages and self-retriggers every 2s unless cancelled

## Optional: test with local SDK changes

If you are developing `packages/inngest` and want this example to consume your local build:

```bash
# from packages/inngest
pnpm build && pnpm local:pack

# from this example directory
npm install --no-save ../../../../packages/inngest/inngest.tgz
```
