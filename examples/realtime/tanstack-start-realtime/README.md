# AI Blog Post Generator — Inngest Realtime + TanStack Start

A multi-step AI content pipeline that streams realtime progress to the browser. Enter a topic, and Inngest orchestrates research, outlining, and drafting — publishing typed updates at each stage via the built-in realtime SDK.

## Quickstart

```bash
# Install dependencies
npm install

# Start the Inngest dev server (in a separate terminal)
npx inngest-cli@latest dev

# Start the app
npm run dev

# visit localhost:8288 and make sure your localhost:3000
# app is synced. if not sync it.
```

Open [http://localhost:3000](http://localhost:3000), enter a topic, and watch the pipeline run.

You'll need an `OPENAI_API_KEY` in `.env` for the AI steps to work. Without one the function will fail, but you can still see the realtime subscription lifecycle in the UI.

## How it works

### Channel & topic definitions (`src/inngest/channels.ts`)

A single parameterized channel scoped per run, with three typed topics:

- **`status`** — Current pipeline step and message (e.g. "Researching topic...")
- **`tokens`** — Individual streaming tokens as the draft is written
- **`artifact`** — Completed artifacts (research notes, outline, final draft)

```ts
const contentPipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    status:   { schema: z.object({ message: z.string(), step: z.string().optional() }) },
    tokens:   { schema: z.object({ token: z.string() }) },
    artifact: { schema: z.object({ kind: z.enum(["research","outline","draft"]), title: z.string(), body: z.string() }) },
  },
});
```

### Inngest function (`src/inngest/functions/generatePost.ts`)

A three-step function demonstrating both publish modes:

- **`inngest.realtime.publish()`** — Fire-and-forget for transient status updates and streaming tokens
- **`step.realtime.publish()`** — Durable publish for artifacts (memoized, won't re-fire on retry)

### Server functions (`src/routes/index.tsx`)

Two TanStack Start server functions:

- **`startPipeline`** — Generates a `runId`, sends the triggering event, returns the ID to the client
- **`getToken`** — Mints a scoped subscription token via `getSubscriptionToken()` for the given run

### React subscription (`src/routes/index.tsx`)

The `useRealtime` hook connects to the parameterized channel and provides:

- `connectionStatus` / `runStatus` — Connection and execution lifecycle
- `isPaused` / `pauseReason` — Explicit pause state for hidden tabs or disabled subscriptions
- `messages.byTopic` — Most recent message per topic
- `messages.all` — Full message log (used to accumulate streaming tokens and list artifacts)
- `messages.last` / `messages.delta` — Convenience views for single latest and incremental batches

### UI components

- **`Pipeline`** — Step progress pills, expandable artifact cards, live-typing draft preview
- **`StatusBadge`** — Connection state dot + run status label
- **`GenerateForm`** — Topic input
